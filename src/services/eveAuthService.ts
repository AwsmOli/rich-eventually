import { computed, ref, toRaw } from "vue";
import { kvDelete, kvGet, kvSet } from "./idbService";

const CLIENT_ID = import.meta.env.VITE_EVE_CLIENT_ID as string;
const SSO_AUTHORIZE = "https://login.eveonline.com/v2/oauth/authorize";
const SSO_TOKEN = "https://login.eveonline.com/v2/oauth/token";
const REDIRECT_URI = window.location.origin + window.location.pathname;

/** Legacy single-account key — migrated to "eve-accounts" on first load. */
const LEGACY_KEY = "eve-auth";
const ACCOUNTS_KEY = "eve-accounts";
const ACTIVE_KEY = "eve-active-char";
const PKCE_KEY = "eve-pkce-verifier";

const SCOPES = [
  "esi-skills.read_skills.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-markets.read_character_orders.v1",
  "esi-assets.read_assets.v1",
  "esi-universe.read_structures.v1",
  "esi-ui.open_window.v1",
  "esi-characters.read_blueprints.v1",
  "esi-industry.read_character_jobs.v1",
].join(" ");

export interface CharacterAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms since epoch
  characterId: number;
  characterName: string;
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Base64Url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── Service ───────────────────────────────────────────────────────────────────

class EveAuthService {
  /** All saved characters. */
  public readonly accounts = ref<CharacterAuth[]>([]);

  /** The currently active character ID. */
  public readonly activeCharacterId = ref<number | undefined>(undefined);

  /** The currently active character — backward-compatible with existing consumers. */
  public readonly character = computed<CharacterAuth | undefined>(() =>
    this.accounts.value.find(
      (a) => a.characterId === this.activeCharacterId.value,
    ),
  );

  /** Resolves once the persisted accounts have been loaded from IDB. */
  private readonly accountsReady: Promise<void>;

  /** Serializes concurrent storeTokens calls to prevent read-modify-write races. */
  private storeTokensQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.accountsReady = this.loadAccounts();
  }

  private async loadAccounts(): Promise<void> {
    // Migrate legacy single-account entry if present.
    const legacy = await kvGet<CharacterAuth>(LEGACY_KEY);
    if (legacy) {
      await kvSet(ACCOUNTS_KEY, [legacy]);
      await kvSet(ACTIVE_KEY, legacy.characterId);
      await kvDelete(LEGACY_KEY);
    }

    const saved = (await kvGet<CharacterAuth[]>(ACCOUNTS_KEY)) ?? [];
    const activeId = await kvGet<number>(ACTIVE_KEY);

    console.log(
      "[eveAuth] loadAccounts: read from IDB",
      saved.map((a) => a.characterName),
      "active:",
      activeId,
    );

    this.accounts.value = saved;
    this.activeCharacterId.value =
      activeId ?? saved[0]?.characterId ?? undefined;
  }

  /** Redirect to EVE SSO to add (or re-authenticate) a character. */
  public async login(): Promise<void> {
    const verifier = randomBase64Url(48);
    const challenge = await sha256Base64Url(verifier);
    sessionStorage.setItem(PKCE_KEY, verifier);

    const state = randomBase64Url(16);
    sessionStorage.setItem("eve-pkce-state", state);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    window.location.href = `${SSO_AUTHORIZE}?${params.toString()}`;
  }

  /** Remove a specific character (defaults to the active one). */
  public removeCharacter(characterId?: number): void {
    const id = characterId ?? this.activeCharacterId.value;
    if (id === undefined) return;

    const remaining = this.accounts.value.filter((a) => a.characterId !== id);
    console.log(
      "[eveAuth] removeCharacter: removing",
      id,
      "→ remaining",
      remaining.map((a) => a.characterName),
    );
    this.accounts.value = remaining;
    void kvSet(
      ACCOUNTS_KEY,
      remaining.map((a) => toRaw(a)),
    );

    if (this.activeCharacterId.value === id) {
      const next = remaining[0]?.characterId ?? undefined;
      this.activeCharacterId.value = next;
      if (next !== undefined) {
        void kvSet(ACTIVE_KEY, next);
      } else {
        void kvDelete(ACTIVE_KEY);
      }
    }
  }

  /** Backward-compatible alias — removes the currently active character. */
  public logout(): void {
    this.removeCharacter();
  }

  /** Switch to a different saved character. */
  public switchTo(characterId: number): void {
    if (!this.accounts.value.some((a) => a.characterId === characterId)) return;
    this.activeCharacterId.value = characterId;
    void kvSet(ACTIVE_KEY, characterId);
  }

  /**
   * Call once on app startup. Exchanges OAuth callback code if present.
   */
  public async handleCallback(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    if (!code) return;

    const expectedState = sessionStorage.getItem("eve-pkce-state");
    if (returnedState !== expectedState) {
      console.error("EVE SSO: state mismatch — possible CSRF");
      return;
    }

    const verifier = sessionStorage.getItem(PKCE_KEY);
    if (!verifier) {
      console.error("EVE SSO: missing PKCE verifier");
      return;
    }

    const cleanUrl =
      window.location.origin + window.location.pathname + window.location.hash;
    history.replaceState(null, "", cleanUrl);
    sessionStorage.removeItem(PKCE_KEY);
    sessionStorage.removeItem("eve-pkce-state");

    await this.exchangeCode(code, verifier);
  }

  /** Returns a valid access token for the given character (default: active). */
  public async getAccessToken(
    characterId?: number,
  ): Promise<string | undefined> {
    const id = characterId ?? this.activeCharacterId.value;
    const auth = this.accounts.value.find((a) => a.characterId === id);
    if (!auth) return undefined;

    if (Date.now() < auth.expiresAt - 60_000) {
      return auth.accessToken;
    }

    return this.refresh(auth);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async exchangeCode(code: string, verifier: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });

    const response = await fetch(SSO_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      console.error("EVE SSO token exchange failed:", await response.text());
      return;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    await this.storeTokens(
      data.access_token,
      data.refresh_token,
      data.expires_in,
    );
  }

  private async refresh(auth: CharacterAuth): Promise<string | undefined> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: CLIENT_ID,
    });

    const response = await fetch(SSO_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.error("EVE SSO refresh failed:", await response.text());
      this.removeCharacter(auth.characterId);
      return undefined;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    await this.storeTokens(
      data.access_token,
      data.refresh_token,
      data.expires_in,
    );
    return data.access_token;
  }

  private storeTokens(
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
  ): Promise<void> {
    // Each call is chained onto the queue so concurrent invocations (e.g. a
    // token refresh for char A racing with a new OAuth callback for char B)
    // execute strictly one at a time and never clobber each other's IDB write.
    const operation = async (): Promise<void> => {
      await this.accountsReady;

      const payload = JSON.parse(atob(accessToken.split(".")[1])) as {
        sub: string;
        name: string;
      };

      const characterId = parseInt(payload.sub.split(":")[2], 10);
      const characterName = payload.name;

      const newAuth: CharacterAuth = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        characterId,
        characterName,
      };

      // Upsert into accounts list.
      const existing = this.accounts.value.filter(
        (a) => a.characterId !== characterId,
      );
      const updated = [...existing, newAuth];
      console.log(
        "[eveAuth] storeTokens: writing",
        updated.map((a) => a.characterName),
        "for",
        characterName,
      );
      this.accounts.value = updated;
      await kvSet(
        ACCOUNTS_KEY,
        updated.map((a) => toRaw(a)),
      );

      // Make this character active (new login always switches to the added char).
      this.activeCharacterId.value = characterId;
      await kvSet(ACTIVE_KEY, characterId);
    };

    // Suppress errors from earlier operations so the queue never gets stuck.
    this.storeTokensQueue = this.storeTokensQueue
      .catch(() => {})
      .then(operation);
    return this.storeTokensQueue;
  }
}

export const eveAuthService = new EveAuthService();
