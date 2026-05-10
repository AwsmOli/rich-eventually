import { eveAuthService } from "./eveAuthService";

const ESI_BASE = "https://esi.evetech.net/latest";

export interface CharacterSkills {
  /** Accounting level (0–5) — affects sales tax */
  accounting: number;
  /** Broker Relations level (0–5) — affects broker fee */
  brokerRelations: number;
}

// Skill type IDs from the EVE static data
const ACCOUNTING_TYPE_ID = 16622;
const BROKER_RELATIONS_TYPE_ID = 3446;

class CharacterService {
  public async getSkills(): Promise<CharacterSkills | undefined> {
    const token = await eveAuthService.getAccessToken();
    if (!token) return undefined;

    const characterId = eveAuthService.character.value?.characterId;
    if (!characterId) return undefined;

    const response = await fetch(
      `${ESI_BASE}/characters/${characterId}/skills/?datasource=tranquility`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      console.error("Failed to fetch character skills:", response.status);
      return undefined;
    }

    const data = (await response.json()) as {
      skills: { skill_id: number; active_skill_level: number }[];
    };

    const getLevel = (typeId: number): number =>
      data.skills.find((s) => s.skill_id === typeId)?.active_skill_level ?? 0;

    return {
      accounting: getLevel(ACCOUNTING_TYPE_ID),
      brokerRelations: getLevel(BROKER_RELATIONS_TYPE_ID),
    };
  }

  public async getWalletBalance(): Promise<number | undefined> {
    const token = await eveAuthService.getAccessToken();
    if (!token) return undefined;

    const characterId = eveAuthService.character.value?.characterId;
    if (!characterId) return undefined;

    const response = await fetch(
      `${ESI_BASE}/characters/${characterId}/wallet/?datasource=tranquility`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      console.error("Failed to fetch wallet balance:", response.status);
      return undefined;
    }

    return (await response.json()) as number;
  }
}

export const characterService = new CharacterService();
