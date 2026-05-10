interface SystemCache {
  id: number;
  name: string;
}

class SystemsService {
  private systemsCache: SystemCache[] = [];
  private cacheLoaded = false;

  public async getSystemsByName(partialName: string): Promise<SystemCache[]> {
    if (!this.cacheLoaded) {
      await this.loadSystemsCache();
    }

    if (partialName.length === 0) {
      return this.systemsCache.slice(0, 50); // Return first 50 if empty
    }

    const lowerName = partialName.toLowerCase();
    return this.systemsCache
      .filter((s) => s.name.toLowerCase().includes(lowerName))
      .slice(0, 50);
  }

  public async getSystemIdByName(
    systemName: string,
  ): Promise<number | undefined> {
    if (!this.cacheLoaded) {
      await this.loadSystemsCache();
    }

    const system = this.systemsCache.find(
      (s) => s.name.toLowerCase() === systemName.toLowerCase(),
    );
    return system?.id;
  }

  private async loadSystemsCache(): Promise<void> {
    try {
      // Use a comprehensive list of major EVE Online systems for autocomplete
      const majorSystems = [
        { id: 30000142, name: "Jita" },
        { id: 30002187, name: "Amarr" },
        { id: 30002659, name: "Dodixie" },
        { id: 30002510, name: "Hek" },
        { id: 30004588, name: "Rens" },
        { id: 30000144, name: "Perimeter" },
        { id: 30000138, name: "Sobaseki" },
        { id: 30000139, name: "Uedama" },
        { id: 30002761, name: "Niarja" },
        { id: 30000143, name: "Isanamo" },
        { id: 30002731, name: "Orvolle" },
        { id: 30000137, name: "Akiainavas" },
        { id: 30000150, name: "Amamake" },
        { id: 30003062, name: "Tash-Murkon Prime" },
        { id: 30000191, name: "Kor-Azor Prime" },
        { id: 30003992, name: "Ashab" },
        { id: 30002529, name: "Kador Prime" },
        { id: 30000194, name: "Dal" },
        { id: 30000140, name: "Hageken" },
        { id: 30000141, name: "Isinokka" },
        { id: 30003670, name: "Geh" },
      ];

      this.systemsCache = majorSystems.sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      this.cacheLoaded = true;
    } catch (error) {
      console.error("Failed to load systems cache:", error);
      this.systemsCache = [];
      this.cacheLoaded = true;
    }
  }
}

export const systemsService = new SystemsService();
