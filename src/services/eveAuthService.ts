import { ref } from "vue";
import { kvDelete, kvGet, kvSet } from "./idbService";

const CLIENT_ID = import.meta.env.VITE_EVE_CLIENT_ID as string;
const SSO_AUTHORIZE = "https://login.eveonline.com/v2/oauth/authorize";
const SSO_TOKEN = "https://login.eveonline.com/v2/oauth/token";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const STORAGE_KEY = "eve-auth";
const PKCE_KEY = "eve-pkce-verifier";

const SCOPES = [
  "esi-skills.read_skills.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-markets.read_character_orders.v1",
  "esi-assets.read_assets.v1",
  "esi-universe.read_structures.v1",
  "esi-ui.open_window.v1",
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
  public readonly character = ref<CharacterAuth | undefined>(undefined);

  constructor() {
    // Load auth from IDB async on startup. The ref will be set when it resolves.
    void kvGet<CharacterAuth>(STORAGE_KEY).then((saved) => {
      if (saved) this.character.value = saved;
    });
  }

  /** Redirect the browser to the EVE SSO login page. */
  public async login(): Promise<void> {
    const verifier = randomBase64Url(48); // 64-char url-safe string
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

  public logout(): void {
    this.character.value = undefined;
    void kvDelete(STORAGE_KEY);
  }

  /**
   * Call this once on app startup. If the URL contains `?code=...` (OAuth
   * callback), exchange it for tokens and clean up the URL.
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

    // Clean the URL so the code isn't reused or leaked in browser history.
    const cleanUrl =
      window.location.origin + window.location.pathname + window.location.hash;
    history.replaceState(null, "", cleanUrl);
    sessionStorage.removeItem(PKCE_KEY);
    sessionStorage.removeItem("eve-pkce-state");

    await this.exchangeCode(code, verifier);
  }

  /** Returns a valid access token, refreshing if necessary. */
  public async getAccessToken(): Promise<string | undefined> {
    const auth = this.character.value;
    if (!auth) return undefined;

    if (Date.now() < auth.expiresAt - 60_000) {
      return auth.accessToken;
    }

    // Token expired (or close to it) — refresh.
    return this.refresh(auth.refreshToken);
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

  private async refresh(refreshToken: string): Promise<string | undefined> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
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
      this.logout();
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

  private async storeTokens(
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
  ): Promise<void> {
    // Decode the JWT payload to get the character info — no signature verification
    // needed here since we're reading public character data only.
    const payload = JSON.parse(atob(accessToken.split(".")[1])) as {
      sub: string; // "CHARACTER:EVE:<id>"
      name: string;
    };

    const characterId = parseInt(payload.sub.split(":")[2], 10);
    const characterName = payload.name;

    const auth: CharacterAuth = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      characterId,
      characterName,
    };

    this.character.value = auth;
    void kvSet(STORAGE_KEY, auth);
  }
}

export const eveAuthService = new EveAuthService();
