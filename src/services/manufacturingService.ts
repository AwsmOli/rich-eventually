import { ref } from "vue";

import { eveAuthService } from "./eveAuthService";
import { kvGet, kvSet } from "./idbService";
import { marketDataService } from "./marketDataService";

const ESI_BASE = "https://esi.evetech.net/latest";
const FUZZWORK_BLUEPRINT_API =
  "https://www.fuzzwork.co.uk/blueprint/api/blueprint.php";

const MATERIAL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — SDE rarely changes
const IDB_MATERIAL_KEY = "mfg-materials-v3:"; // v3: null sentinels only for logical negatives

// ── ESI wire types ────────────────────────────────────────────────────────────

interface EsiBlueprint {
  item_id: number;
  type_id: number;
  location_id: number;
  location_flag: string;
  quantity: number; // -1 = BPO, -2 = BPC
  runs: number; // -1 = unlimited (BPO), ≥0 for copies
  material_efficiency: number; // 0–10
  time_efficiency: number; // 0–20
}

interface EsiIndustryJob {
  job_id: number;
  activity_id: number; // 1 = manufacturing
  blueprint_type_id: number;
  product_type_id: number;
  product_quantity: number;
  runs: number;
  status:
    | "active"
    | "cancelled"
    | "delivered"
    | "paused"
    | "ready"
    | "reverted";
  start_date: string;
  end_date: string;
  cost: number; // facility/system job cost (NOT raw materials)
}

// Fuzzwork blueprint.php response
interface FuzzworkData {
  blueprintDetails?: {
    productTypeID?: number;
    productTypeName?: string;
    productQuantity?: number;
    times?: Record<string, number>; // activity_id → seconds; "1" = manufacturing
  };
  activityMaterials?: Record<
    string,
    Array<{
      // activity_id → materials
      typeid: number;
      name: string;
      quantity: number;
    }>
  >;
}

// ── Domain types ──────────────────────────────────────────────────────────────

export interface CharacterBlueprint {
  itemId: number;
  typeId: number;
  typeName: string;
  productTypeId: number;
  productName: string;
  locationId: number;
  isOriginal: boolean;
  runs: number; // -1 = unlimited
  materialEfficiency: number;
  timeEfficiency: number;
}

export interface MfgMaterial {
  typeId: number;
  typeName: string;
  baseQty: number;
  /** baseQty adjusted for blueprint ME level */
  adjustedQty: number;
  unitCost: number;
  totalCost: number;
}

export interface ManufacturingOpportunity {
  blueprintTypeId: number;
  blueprintName: string;
  productTypeId: number;
  productName: string;
  producesQty: number;
  baseTimeSec: number;
  materials: MfgMaterial[];
  /** Sum of material costs with ME applied */
  materialCost: number;
  /** Cheapest current sell order for the product (in the scanned region) */
  productSellPrice: number | undefined;
  /** 90-day average transaction price for the product */
  product90dAvg: number | undefined;
  salesTaxRate: number;
  /** Profit using current sell price as revenue */
  netProfitVsSell: number | undefined;
  /** Profit using 90d avg as revenue */
  netProfitVs90d: number | undefined;
  marginVsSell: number | undefined;
  marginVs90d: number | undefined;
  /** Average daily traded volume over 90 days */
  product90dDailyVolume: number | undefined;
  /** The best-ME owned blueprint for this type, if the character has one */
  ownedBlueprint: CharacterBlueprint | undefined;
}

export interface ManufacturingJob {
  jobId: number;
  blueprintTypeId: number;
  productTypeId: number;
  productName: string;
  runs: number;
  outputQty: number;
  status: EsiIndustryJob["status"];
  startDate: string;
  endDate: string;
  /** ESI "cost" = system/facility job cost — does NOT include raw materials */
  facilityCost: number;
  productSellPrice: number | undefined;
  expectedRevenue: number | undefined;
  /** revenue × (1 − salesTax) − facilityCost (no raw material data available from ESI) */
  expectedProfit: number | undefined;
  percentComplete: number;
}

// Cached Fuzzwork result stored in IDB
interface MaterialRecord {
  blueprintTypeId: number;
  productTypeId: number;
  producesQty: number;
  baseTimeSec: number;
  materials: Array<{ typeId: number; quantity: number }>;
  cachedAt: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

class ManufacturingService {
  public readonly isLoading = ref(false);
  public readonly blueprints = ref<CharacterBlueprint[]>([]);
  public readonly opportunities = ref<ManufacturingOpportunity[]>([]);
  public readonly jobs = ref<ManufacturingJob[]>([]);
  public readonly progress = ref({ step: "", current: 0, total: 0 });
  public readonly lastError = ref<string | null>(null);
  public readonly needsRelogin = ref(false);

  private accountingLevel = 5;
  private readonly materialMemCache = new Map<number, MaterialRecord | null>();

  public setAccountingLevel(level: number): void {
    this.accountingLevel = level;
  }

  /**
   * Main entry point. Fetches character blueprints + industry jobs, resolves
   * blueprint materials from Fuzzwork (cached), then computes per-run profit
   * using the current market scan data for the given region.
   */
  public async load(regionId: number): Promise<void> {
    if (this.isLoading.value) return;
    const character = eveAuthService.character.value;
    if (!character) return;

    this.isLoading.value = true;
    this.progress.value = {
      step: "Fetching character data…",
      current: 0,
      total: 0,
    };

    try {
      const token = await eveAuthService.getAccessToken();
      if (!token) {
        console.error("[mfg] No access token");
        return;
      }

      const [esiBps, esiJobs] = await Promise.all([
        this.fetchBlueprints(token, character.characterId),
        this.fetchIndustryJobs(token, character.characterId),
      ]);

      console.log(
        `[mfg] ESI blueprints: ${esiBps.length}, jobs: ${esiJobs.length}`,
      );

      // Only manufacturing blueprints (activity_id 1).
      // Blueprints with quantity == -2 and runs == 0 are exhausted BPCs — skip.
      const usable = esiBps.filter(
        (bp) => !(bp.quantity === -2 && bp.runs === 0),
      );
      const uniqueTypeIds = [...new Set(usable.map((b) => b.type_id))];
      console.log(
        `[mfg] Usable blueprints: ${usable.length}, unique types: ${uniqueTypeIds.length}`,
      );

      // Fetch material data for each unique blueprint type.
      this.progress.value = {
        step: "Fetching blueprint materials…",
        current: 0,
        total: uniqueTypeIds.length,
      };

      const materialMap = new Map<number, MaterialRecord | null>();
      for (let i = 0; i < uniqueTypeIds.length; i++) {
        const bpTypeId = uniqueTypeIds[i];
        this.progress.value = {
          step: "Fetching blueprint materials…",
          current: i + 1,
          total: uniqueTypeIds.length,
        };
        materialMap.set(bpTypeId, await this.getMaterialRecord(bpTypeId));
      }

      const nullCount = [...materialMap.values()].filter(
        (v) => v === null,
      ).length;
      console.log(
        `[mfg] materialMap: ${materialMap.size} total, ${nullCount} null (no mfg activity)`,
      );

      // Also include blueprint types referenced by active jobs but not in hangar.
      const jobBpTypeIds = esiJobs
        .filter((j) => j.activity_id === 1)
        .map((j) => j.blueprint_type_id)
        .filter((id) => !materialMap.has(id));
      for (const id of jobBpTypeIds) {
        if (!materialMap.has(id)) {
          materialMap.set(id, await this.getMaterialRecord(id));
        }
      }

      // Collect all type IDs that need name resolution.
      const allTypeIds = new Set<number>();
      for (const [, rec] of materialMap) {
        if (!rec) continue;
        allTypeIds.add(rec.productTypeId);
        for (const m of rec.materials) allTypeIds.add(m.typeId);
      }
      for (const bp of usable) allTypeIds.add(bp.type_id);
      for (const job of esiJobs) allTypeIds.add(job.product_type_id);

      this.progress.value = { step: "Resolving names…", current: 0, total: 0 };
      const nameMap = await marketDataService.getNames([...allTypeIds]);

      // Build CharacterBlueprint list.
      const charBps: CharacterBlueprint[] = [];
      for (const bp of usable) {
        const rec = materialMap.get(bp.type_id);
        if (!rec) continue; // no manufacturing activity — skip
        charBps.push({
          itemId: bp.item_id,
          typeId: bp.type_id,
          typeName: nameMap[bp.type_id] ?? `Blueprint ${bp.type_id}`,
          productTypeId: rec.productTypeId,
          productName:
            nameMap[rec.productTypeId] ?? `Item ${rec.productTypeId}`,
          locationId: bp.location_id,
          isOriginal: bp.quantity === -1,
          runs: bp.runs,
          materialEfficiency: bp.material_efficiency,
          timeEfficiency: bp.time_efficiency,
        });
      }
      this.blueprints.value = charBps;

      // Keep best-ME blueprint per type.
      const bestByType = new Map<number, CharacterBlueprint>();
      for (const bp of charBps) {
        const prev = bestByType.get(bp.typeId);
        if (!prev || bp.materialEfficiency > prev.materialEfficiency) {
          bestByType.set(bp.typeId, bp);
        }
      }

      // Pre-fetch history summaries in parallel so they're in memory-cache.
      this.progress.value = {
        step: "Fetching price history…",
        current: 0,
        total: 0,
      };
      const productTypeIds = [...materialMap.values()]
        .filter((r) => r !== null)
        .map((r) => r!.productTypeId);
      await Promise.all(
        productTypeIds.map((id) =>
          marketDataService.getHistorySummary(regionId, id),
        ),
      );

      // Compute opportunities.
      this.progress.value = {
        step: "Computing profitability…",
        current: 0,
        total: 0,
      };
      const salesTaxRate = 0.08 * Math.max(0, 1 - this.accountingLevel * 0.11);
      const opportunities: ManufacturingOpportunity[] = [];

      for (const [bpTypeId, rec] of materialMap) {
        if (!rec || rec.materials.length === 0) continue;

        const ownedBp = bestByType.get(bpTypeId);
        const me = ownedBp?.materialEfficiency ?? 0;

        let materialCost = 0;
        const materials: MfgMaterial[] = rec.materials.map((m) => {
          const adjustedQty = Math.max(
            1,
            Math.ceil(m.quantity * (1 - me / 100)),
          );
          const unitCost =
            marketDataService.getLowestSellPrice(regionId, m.typeId) ?? 0;
          const totalCost = adjustedQty * unitCost;
          materialCost += totalCost;
          return {
            typeId: m.typeId,
            typeName: nameMap[m.typeId] ?? `Item ${m.typeId}`,
            baseQty: m.quantity,
            adjustedQty,
            unitCost,
            totalCost,
          };
        });

        const productSellPrice = marketDataService.getLowestSellPrice(
          regionId,
          rec.productTypeId,
        );
        const historySummary = marketDataService.getHistorySummarySync(
          regionId,
          rec.productTypeId,
        );
        const product90dAvg = historySummary?.avgPrice;

        const revenueVsSell =
          productSellPrice !== undefined
            ? productSellPrice * rec.producesQty
            : undefined;
        const revenueVs90d =
          product90dAvg !== undefined
            ? product90dAvg * rec.producesQty
            : undefined;

        const netProfitVsSell =
          revenueVsSell !== undefined
            ? revenueVsSell * (1 - salesTaxRate) - materialCost
            : undefined;
        const netProfitVs90d =
          revenueVs90d !== undefined
            ? revenueVs90d * (1 - salesTaxRate) - materialCost
            : undefined;

        opportunities.push({
          blueprintTypeId: bpTypeId,
          blueprintName: nameMap[bpTypeId] ?? `Blueprint ${bpTypeId}`,
          productTypeId: rec.productTypeId,
          productName:
            nameMap[rec.productTypeId] ?? `Item ${rec.productTypeId}`,
          producesQty: rec.producesQty,
          baseTimeSec: rec.baseTimeSec,
          materials,
          materialCost,
          productSellPrice,
          product90dAvg,
          salesTaxRate,
          netProfitVsSell,
          netProfitVs90d,
          marginVsSell:
            netProfitVsSell !== undefined && materialCost > 0
              ? netProfitVsSell / materialCost
              : undefined,
          marginVs90d:
            netProfitVs90d !== undefined && materialCost > 0
              ? netProfitVs90d / materialCost
              : undefined,
          product90dDailyVolume: historySummary?.avgVolume,
          ownedBlueprint: ownedBp,
        });
      }

      this.opportunities.value = opportunities.sort(
        (a, b) =>
          (b.marginVs90d ?? b.marginVsSell ?? -Infinity) -
          (a.marginVs90d ?? a.marginVsSell ?? -Infinity),
      );
      console.log(
        `[mfg] Done: ${charBps.length} blueprints, ${opportunities.length} opportunities, ${this.jobs.value.length} jobs`,
      );

      // Process industry jobs (manufacturing only).
      const mfgJobs = esiJobs.filter((j) => j.activity_id === 1);
      const jobs: ManufacturingJob[] = mfgJobs.map((job) => {
        const productSellPrice = marketDataService.getLowestSellPrice(
          regionId,
          job.product_type_id,
        );
        const expectedRevenue =
          productSellPrice !== undefined
            ? productSellPrice * job.product_quantity
            : undefined;
        const expectedProfit =
          expectedRevenue !== undefined
            ? expectedRevenue * (1 - salesTaxRate) - job.cost
            : undefined;

        const startMs = new Date(job.start_date).getTime();
        const endMs = new Date(job.end_date).getTime();
        const duration = endMs - startMs;
        const elapsed = Math.min(Date.now() - startMs, duration);
        const pct =
          job.status === "delivered" || job.status === "ready"
            ? 100
            : duration > 0
              ? Math.round((elapsed / duration) * 100)
              : 0;

        return {
          jobId: job.job_id,
          blueprintTypeId: job.blueprint_type_id,
          productTypeId: job.product_type_id,
          productName:
            nameMap[job.product_type_id] ?? `Item ${job.product_type_id}`,
          runs: job.runs,
          outputQty: job.product_quantity,
          status: job.status,
          startDate: job.start_date,
          endDate: job.end_date,
          facilityCost: job.cost,
          productSellPrice,
          expectedRevenue,
          expectedProfit,
          percentComplete: pct,
        };
      });

      // Sort: ready first, then active by end date, then delivered.
      this.jobs.value = jobs.sort((a, b) => {
        const rank = (j: ManufacturingJob): number =>
          j.status === "ready" ? 0 : j.status === "active" ? 1 : 2;
        const dr = rank(a) - rank(b);
        if (dr !== 0) return dr;
        return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
      });
      this.lastError.value = null;
      this.needsRelogin.value = false;
    } catch (err) {
      console.error("[manufacturingService] load failed:", err);
      if (err instanceof Error && err.message === "MISSING_SCOPE") {
        this.needsRelogin.value = true;
        this.lastError.value = null;
      } else {
        this.lastError.value = String(err);
      }
    } finally {
      this.isLoading.value = false;
      this.progress.value = { step: "", current: 0, total: 0 };
    }
  }

  /**
   * Combined scan: checks every sell-order item in the region for manufacturing
   * profitability. If a character is logged in, also fetches their blueprints
   * and industry jobs so owned BPs are annotated and ME is applied to their
   * material cost. Owned blueprints are pinned at the top of results.
   * Delivered industry jobs are excluded.
   */
  public async scan(regionId: number): Promise<void> {
    if (this.isLoading.value) return;

    this.isLoading.value = true;
    this.needsRelogin.value = false;
    this.lastError.value = null;
    // Do NOT clear blueprints / jobs here — keep previous values visible
    // while the scan runs so the UI doesn't flicker.
    this.progress.value = {
      step: "Reading market orders…",
      current: 0,
      total: 0,
    };

    try {
      // Optionally fetch character data in parallel if logged in.
      const character = eveAuthService.character.value;
      let esiBps: EsiBlueprint[] = [];
      let esiJobs: EsiIndustryJob[] = [];
      if (character) {
        try {
          const token = await eveAuthService.getAccessToken();
          if (token) {
            [esiBps, esiJobs] = await Promise.all([
              this.fetchBlueprints(token, character.characterId),
              this.fetchIndustryJobs(token, character.characterId),
            ]);
            console.log(
              `[mfg/scan] ESI: ${esiBps.length} blueprints, ${esiJobs.length} jobs`,
            );
          }
        } catch (err) {
          if (err instanceof Error && err.message === "MISSING_SCOPE") {
            this.needsRelogin.value = true;
          } else {
            console.warn("[mfg/scan] character data fetch failed:", err);
          }
        }
      }

      // Collect unique typeIds from sell orders (≥ 50k ISK) in this region.
      const allOrders = marketDataService.getRegionOrders(regionId);
      const marketTypeIds = new Set(
        allOrders
          .filter((o) => !o.isBuyOrder && o.price >= 50_000)
          .map((o) => o.typeId),
      );

      // Also include owned blueprint type IDs so they appear even if off-market.
      const usableBps = esiBps.filter(
        (bp) => !(bp.quantity === -2 && bp.runs === 0),
      );
      for (const bp of usableBps) marketTypeIds.add(bp.type_id);

      const typeIds = [...marketTypeIds];
      console.log(`[mfg/scan] ${typeIds.length} candidate typeIds`);

      // Fast-path: drain memory cache synchronously for already-known types.
      // This makes repeat presses near-instant — only uncached types go async.
      const materialMap = new Map<number, MaterialRecord | null>();
      const uncached: number[] = [];
      for (const id of typeIds) {
        const mem = this.materialMemCache.get(id);
        if (mem !== undefined) {
          materialMap.set(id, mem);
        } else {
          uncached.push(id);
        }
      }
      console.log(
        `[mfg/scan] ${materialMap.size} from cache, ${uncached.length} need Fuzzwork`,
      );

      // Async batches only for the uncached subset.
      // Capture cachedCount before the loop so it doesn't grow with materialMap.
      const cachedCount = materialMap.size;
      const BATCH = 50;
      for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH);
        this.progress.value = {
          step: "Checking blueprints…",
          current: cachedCount + i,
          total: typeIds.length,
        };
        const results = await Promise.all(
          batch.map((id) => this.getMaterialRecord(id)),
        );
        batch.forEach((id, j) => materialMap.set(id, results[j]));
      }

      // Collect all type IDs needing name resolution.
      this.progress.value = { step: "Resolving names…", current: 0, total: 0 };
      const allTypeIds = new Set<number>();
      for (const [, rec] of materialMap) {
        if (!rec) continue;
        allTypeIds.add(rec.blueprintTypeId);
        allTypeIds.add(rec.productTypeId);
        for (const m of rec.materials) allTypeIds.add(m.typeId);
      }
      for (const bp of usableBps) allTypeIds.add(bp.type_id);
      for (const job of esiJobs) allTypeIds.add(job.product_type_id);
      const nameMap = await marketDataService.getNames([...allTypeIds]);

      // Build owned-blueprint lookup keyed by blueprint type ID.
      const charBps: CharacterBlueprint[] = [];
      const bestByType = new Map<number, CharacterBlueprint>();
      for (const bp of usableBps) {
        const rec = materialMap.get(bp.type_id);
        if (!rec) continue;
        const charBp: CharacterBlueprint = {
          itemId: bp.item_id,
          typeId: bp.type_id,
          typeName: nameMap[bp.type_id] ?? `Blueprint ${bp.type_id}`,
          productTypeId: rec.productTypeId,
          productName:
            nameMap[rec.productTypeId] ?? `Item ${rec.productTypeId}`,
          locationId: bp.location_id,
          isOriginal: bp.quantity === -1,
          runs: bp.runs,
          materialEfficiency: bp.material_efficiency,
          timeEfficiency: bp.time_efficiency,
        };
        charBps.push(charBp);
        const prev = bestByType.get(bp.type_id);
        if (!prev || bp.material_efficiency > prev.materialEfficiency) {
          bestByType.set(bp.type_id, charBp);
        }
      }
      this.blueprints.value = charBps;

      // Pre-fetch history summaries for candidate product types — but only the
      // ones not already in the in-memory summary cache. These are small IDB/ESI
      // calls (~200 per scan on a cold session, near-zero on a warm one) and
      // provide the 90d avg + daily volume that drives the filter.
      {
        const candidateProductIds = new Set<number>();
        for (const [bpTypeId, rec] of materialMap) {
          if (!rec || rec.materials.length === 0) continue;
          const owned = bestByType.has(bpTypeId);
          if (
            !owned &&
            (bpTypeId === rec.productTypeId ||
              marketDataService.getLowestSellPrice(regionId, bpTypeId) ===
                undefined)
          )
            continue;
          candidateProductIds.add(rec.productTypeId);
        }
        const needsHistory = [...candidateProductIds].filter(
          (id) =>
            marketDataService.getHistorySummarySync(regionId, id) === undefined,
        );
        if (needsHistory.length > 0) {
          this.progress.value = {
            step: "Fetching price history…",
            current: 0,
            total: needsHistory.length,
          };
          const HIST_BATCH = 40;
          for (let i = 0; i < needsHistory.length; i += HIST_BATCH) {
            await Promise.all(
              needsHistory
                .slice(i, i + HIST_BATCH)
                .map((id) => marketDataService.getHistorySummary(regionId, id)),
            );
            this.progress.value = {
              step: "Fetching price history…",
              current: Math.min(i + HIST_BATCH, needsHistory.length),
              total: needsHistory.length,
            };
          }
        }
      }

      // Compute profitability for every candidate blueprint type.
      this.progress.value = {
        step: "Computing profitability…",
        current: 0,
        total: 0,
      };
      const salesTaxRate = 0.08 * Math.max(0, 1 - this.accountingLevel * 0.11);
      const opportunities: ManufacturingOpportunity[] = [];

      for (const [bpTypeId, rec] of materialMap) {
        if (!rec || rec.materials.length === 0) continue;

        const ownedBp = bestByType.get(bpTypeId);

        if (!ownedBp) {
          // If the queried typeId equals the product typeId, Fuzzwork matched on
          // the product item (e.g. Praxis ship), not an actual blueprint listing.
          // There's no purchasable blueprint for this item — skip it.
          if (bpTypeId === rec.productTypeId) continue;

          // Also skip if the blueprint itself has no sell orders in the region
          // (removed from game, contract-only, etc.).
          if (
            marketDataService.getLowestSellPrice(regionId, bpTypeId) ===
            undefined
          )
            continue;
        }

        const me = ownedBp?.materialEfficiency ?? 0;

        let materialCost = 0;
        const materials: MfgMaterial[] = rec.materials.map((m) => {
          const adjustedQty = Math.max(
            1,
            Math.ceil(m.quantity * (1 - me / 100)),
          );
          const unitCost =
            marketDataService.getLowestSellPrice(regionId, m.typeId) ?? 0;
          const totalCost = adjustedQty * unitCost;
          materialCost += totalCost;
          return {
            typeId: m.typeId,
            typeName: nameMap[m.typeId] ?? `Item ${m.typeId}`,
            baseQty: m.quantity,
            adjustedQty,
            unitCost,
            totalCost,
          };
        });
        if (materialCost === 0) continue;

        const productSellPrice = marketDataService.getLowestSellPrice(
          regionId,
          rec.productTypeId,
        );
        const historySummary = marketDataService.getHistorySummarySync(
          regionId,
          rec.productTypeId,
        );
        const product90dAvg = historySummary?.avgPrice;
        const product90dDailyVolume = historySummary?.avgVolume;
        const revenueVsSell =
          productSellPrice !== undefined
            ? productSellPrice * rec.producesQty
            : undefined;
        const revenueVs90d =
          product90dAvg !== undefined
            ? product90dAvg * rec.producesQty
            : undefined;
        const netProfitVsSell =
          revenueVsSell !== undefined
            ? revenueVsSell * (1 - salesTaxRate) - materialCost
            : undefined;
        const netProfitVs90d =
          revenueVs90d !== undefined
            ? revenueVs90d * (1 - salesTaxRate) - materialCost
            : undefined;

        opportunities.push({
          blueprintTypeId: bpTypeId,
          blueprintName: nameMap[bpTypeId] ?? `Blueprint ${bpTypeId}`,
          productTypeId: rec.productTypeId,
          productName:
            nameMap[rec.productTypeId] ?? `Item ${rec.productTypeId}`,
          producesQty: rec.producesQty,
          baseTimeSec: rec.baseTimeSec,
          materials,
          materialCost,
          productSellPrice,
          product90dAvg,
          salesTaxRate,
          netProfitVsSell,
          netProfitVs90d,
          marginVsSell:
            netProfitVsSell !== undefined && materialCost > 0
              ? netProfitVsSell / materialCost
              : undefined,
          marginVs90d:
            netProfitVs90d !== undefined && materialCost > 0
              ? netProfitVs90d / materialCost
              : undefined,
          product90dDailyVolume,
          ownedBlueprint: ownedBp,
        });
      }

      // Sort by profitability (component will pin owned first, cap unowned at 50).
      this.opportunities.value = opportunities.sort(
        (a, b) =>
          (b.marginVs90d ?? b.marginVsSell ?? -Infinity) -
          (a.marginVs90d ?? a.marginVsSell ?? -Infinity),
      );

      // Build job list — exclude delivered jobs.
      const mfgJobs = esiJobs.filter(
        (j) => j.activity_id === 1 && j.status !== "delivered",
      );
      const jobs: ManufacturingJob[] = mfgJobs.map((job) => {
        const productSellPrice = marketDataService.getLowestSellPrice(
          regionId,
          job.product_type_id,
        );
        const expectedRevenue =
          productSellPrice !== undefined
            ? productSellPrice * job.product_quantity
            : undefined;
        const expectedProfit =
          expectedRevenue !== undefined
            ? expectedRevenue * (1 - salesTaxRate) - job.cost
            : undefined;
        const startMs = new Date(job.start_date).getTime();
        const endMs = new Date(job.end_date).getTime();
        const duration = endMs - startMs;
        const elapsed = Math.min(Date.now() - startMs, duration);
        const pct =
          job.status === "ready"
            ? 100
            : duration > 0
              ? Math.round((elapsed / duration) * 100)
              : 0;
        return {
          jobId: job.job_id,
          blueprintTypeId: job.blueprint_type_id,
          productTypeId: job.product_type_id,
          productName:
            nameMap[job.product_type_id] ?? `Item ${job.product_type_id}`,
          runs: job.runs,
          outputQty: job.product_quantity,
          status: job.status,
          startDate: job.start_date,
          endDate: job.end_date,
          facilityCost: job.cost,
          productSellPrice,
          expectedRevenue,
          expectedProfit,
          percentComplete: pct,
        };
      });
      this.jobs.value = jobs.sort((a, b) => {
        const rank = (j: ManufacturingJob): number =>
          j.status === "ready" ? 0 : j.status === "active" ? 1 : 2;
        const dr = rank(a) - rank(b);
        if (dr !== 0) return dr;
        return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
      });

      console.log(
        `[mfg/scan] Done: ${charBps.length} owned bps, ${opportunities.length} opportunities, ${jobs.length} jobs`,
      );
      if (!this.needsRelogin.value) this.lastError.value = null;
    } catch (err) {
      console.error("[mfg/scan] scan failed:", err);
      this.lastError.value = String(err);
    } finally {
      this.isLoading.value = false;
      this.progress.value = { step: "", current: 0, total: 0 };
    }
  }

  /**
   * Market-wide blueprint scan — no auth required.
   * Takes every item with sell orders in the given region and checks Fuzzwork
   * for manufacturing data. Shows profitable opportunities for ALL blueprints,
   * regardless of character ownership.
   */
  public async loadMarket(regionId: number): Promise<void> {
    if (this.isLoading.value) return;

    this.isLoading.value = true;
    this.needsRelogin.value = false;
    this.lastError.value = null;
    // Keep previous values visible while the scan runs.
    this.progress.value = {
      step: "Reading market orders…",
      current: 0,
      total: 0,
    };

    try {
      // Collect unique typeIds from sell orders in this region.
      const allOrders = marketDataService.getRegionOrders(regionId);
      const typeIds = [
        ...new Set(
          allOrders
            .filter((o) => !o.isBuyOrder && o.price >= 50_000)
            .map((o) => o.typeId),
        ),
      ];

      console.log(
        `[mfg/market] ${typeIds.length} candidate typeIds from sell orders`,
      );

      // Fetch material records in parallel batches.
      const BATCH = 20;
      const materialMap = new Map<number, MaterialRecord | null>();

      for (let i = 0; i < typeIds.length; i += BATCH) {
        const batch = typeIds.slice(i, i + BATCH);
        this.progress.value = {
          step: "Checking blueprints…",
          current: i,
          total: typeIds.length,
        };
        const results = await Promise.all(
          batch.map((id) => this.getMaterialRecord(id)),
        );
        batch.forEach((id, j) => materialMap.set(id, results[j]));
      }

      const withData = [...materialMap.values()].filter(
        (v) => v !== null,
      ).length;
      console.log(`[mfg/market] ${withData} typeIds have manufacturing data`);

      // Resolve names for all relevant types.
      this.progress.value = { step: "Resolving names…", current: 0, total: 0 };
      const allTypeIds = new Set<number>();
      for (const [, rec] of materialMap) {
        if (!rec) continue;
        allTypeIds.add(rec.blueprintTypeId);
        allTypeIds.add(rec.productTypeId);
        for (const m of rec.materials) allTypeIds.add(m.typeId);
      }
      const nameMap = await marketDataService.getNames([...allTypeIds]);

      // Pre-fetch price history.
      this.progress.value = {
        step: "Fetching price history…",
        current: 0,
        total: 0,
      };
      const productTypeIds = [...materialMap.values()]
        .filter((r) => r !== null)
        .map((r) => r!.productTypeId);
      await Promise.all(
        productTypeIds.map((id) =>
          marketDataService.getHistorySummary(regionId, id),
        ),
      );

      // Compute profitability.
      this.progress.value = {
        step: "Computing profitability…",
        current: 0,
        total: 0,
      };
      const salesTaxRate = 0.08 * Math.max(0, 1 - this.accountingLevel * 0.11);
      const opportunities: ManufacturingOpportunity[] = [];

      for (const [queriedTypeId, rec] of materialMap) {
        if (!rec || rec.materials.length === 0) continue;

        let materialCost = 0;
        const materials: MfgMaterial[] = rec.materials.map((m) => {
          const unitCost =
            marketDataService.getLowestSellPrice(regionId, m.typeId) ?? 0;
          const totalCost = m.quantity * unitCost;
          materialCost += totalCost;
          return {
            typeId: m.typeId,
            typeName: nameMap[m.typeId] ?? `Item ${m.typeId}`,
            baseQty: m.quantity,
            adjustedQty: m.quantity,
            unitCost,
            totalCost,
          };
        });

        if (materialCost === 0) continue;

        const productSellPrice = marketDataService.getLowestSellPrice(
          regionId,
          rec.productTypeId,
        );
        const lmHistorySummary = marketDataService.getHistorySummarySync(
          regionId,
          rec.productTypeId,
        );
        const product90dAvg = lmHistorySummary?.avgPrice;

        const revenueVsSell =
          productSellPrice !== undefined
            ? productSellPrice * rec.producesQty
            : undefined;
        const revenueVs90d =
          product90dAvg !== undefined
            ? product90dAvg * rec.producesQty
            : undefined;
        const netProfitVsSell =
          revenueVsSell !== undefined
            ? revenueVsSell * (1 - salesTaxRate) - materialCost
            : undefined;
        const netProfitVs90d =
          revenueVs90d !== undefined
            ? revenueVs90d * (1 - salesTaxRate) - materialCost
            : undefined;

        opportunities.push({
          blueprintTypeId: queriedTypeId,
          blueprintName: nameMap[queriedTypeId] ?? `Blueprint ${queriedTypeId}`,
          productTypeId: rec.productTypeId,
          productName:
            nameMap[rec.productTypeId] ?? `Item ${rec.productTypeId}`,
          producesQty: rec.producesQty,
          baseTimeSec: rec.baseTimeSec,
          materials,
          materialCost,
          productSellPrice,
          product90dAvg,
          salesTaxRate,
          netProfitVsSell,
          netProfitVs90d,
          marginVsSell:
            netProfitVsSell !== undefined && materialCost > 0
              ? netProfitVsSell / materialCost
              : undefined,
          marginVs90d:
            netProfitVs90d !== undefined && materialCost > 0
              ? netProfitVs90d / materialCost
              : undefined,
          product90dDailyVolume: lmHistorySummary?.avgVolume,
          ownedBlueprint: undefined,
        });
      }

      this.opportunities.value = opportunities.sort(
        (a, b) =>
          (b.marginVs90d ?? b.marginVsSell ?? -Infinity) -
          (a.marginVs90d ?? a.marginVsSell ?? -Infinity),
      );
      console.log(`[mfg/market] Done: ${opportunities.length} opportunities`);
    } catch (err) {
      console.error("[mfg/market] loadMarket failed:", err);
      this.lastError.value = String(err);
    } finally {
      this.isLoading.value = false;
      this.progress.value = { step: "", current: 0, total: 0 };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async fetchBlueprints(
    token: string,
    characterId: number,
  ): Promise<EsiBlueprint[]> {
    const page1Resp = await fetch(
      `${ESI_BASE}/characters/${characterId}/blueprints/?datasource=tranquility&page=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!page1Resp.ok) {
      const body = await page1Resp.text().catch(() => "");
      console.error(
        `[mfg] fetchBlueprints failed: ${page1Resp.status} ${page1Resp.statusText}`,
        body,
      );
      if (page1Resp.status === 401) {
        throw new Error("MISSING_SCOPE");
      }
      return [];
    }

    const xPages = Number.parseInt(page1Resp.headers.get("x-pages") ?? "1", 10);
    const page1 = (await page1Resp.json()) as EsiBlueprint[];
    if (xPages === 1) return page1;

    const rest = await Promise.all(
      Array.from({ length: xPages - 1 }, (_, i) =>
        fetch(
          `${ESI_BASE}/characters/${characterId}/blueprints/?datasource=tranquility&page=${i + 2}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ).then((r) =>
          r.ok ? (r.json() as Promise<EsiBlueprint[]>) : ([] as EsiBlueprint[]),
        ),
      ),
    );
    return page1.concat(...rest);
  }

  private async fetchIndustryJobs(
    token: string,
    characterId: number,
  ): Promise<EsiIndustryJob[]> {
    // include_completed=true shows recent finished jobs too.
    const resp = await fetch(
      `${ESI_BASE}/characters/${characterId}/industry/jobs/?datasource=tranquility&include_completed=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return [];
    return resp.json() as Promise<EsiIndustryJob[]>;
  }

  /**
   * Returns cached material data for a blueprint type, or fetches from Fuzzwork.
   * Returns null if the blueprint has no manufacturing activity.
   */
  private async getMaterialRecord(
    blueprintTypeId: number,
  ): Promise<MaterialRecord | null> {
    // 1. Memory cache
    const mem = this.materialMemCache.get(blueprintTypeId);
    if (mem !== undefined) return mem;

    // 2. IDB cache — stores both real records AND null sentinels so we don't
    //    re-hit Fuzzwork for non-blueprint items after a page reload.
    const idbKey = `${IDB_MATERIAL_KEY}${blueprintTypeId}`;
    try {
      const stored = await kvGet<MaterialRecord & { _null?: true }>(idbKey);
      if (stored && stored.cachedAt + MATERIAL_CACHE_TTL_MS > Date.now()) {
        const result = stored._null ? null : (stored as MaterialRecord);
        this.materialMemCache.set(blueprintTypeId, result);
        return result;
      }
    } catch {
      // IDB unavailable — fall through
    }

    // 3. Fetch from Fuzzwork blueprint API
    // persistNull caches the "definitely not a blueprint" result in both memory and IDB.
    // Only call this for logical negatives — NOT for transient HTTP/network errors.
    const persistNull = (): null => {
      this.materialMemCache.set(blueprintTypeId, null);
      void kvSet(idbKey, { _null: true, cachedAt: Date.now() });
      return null;
    };

    try {
      const resp = await fetch(
        `${FUZZWORK_BLUEPRINT_API}?typeid=${blueprintTypeId}`,
      );
      if (!resp.ok) {
        // Transient error — cache only in memory so the next page load retries.
        this.materialMemCache.set(blueprintTypeId, null);
        console.warn(
          `[mfg] Fuzzwork ${resp.status} for typeId ${blueprintTypeId}`,
        );
        return null;
      }

      const data = (await resp.json()) as FuzzworkData;
      const productTypeId = data.blueprintDetails?.productTypeID;
      if (!productTypeId) {
        // Expected for non-blueprint items — no warn needed.
        return persistNull();
      }

      const mfgMaterials = data.activityMaterials?.["1"];
      if (!mfgMaterials?.length) {
        // No manufacturing activity for this blueprint
        return persistNull();
      }

      const record: MaterialRecord = {
        blueprintTypeId,
        productTypeId,
        producesQty: data.blueprintDetails?.productQuantity ?? 1,
        baseTimeSec: data.blueprintDetails?.times?.["1"] ?? 0,
        materials: mfgMaterials
          .filter((m) => m.typeid > 0 && m.quantity > 0)
          .map((m) => ({ typeId: m.typeid, quantity: m.quantity })),
        cachedAt: Date.now(),
      };

      this.materialMemCache.set(blueprintTypeId, record);
      void kvSet(idbKey, record);
      return record;
    } catch (err) {
      // SyntaxError = empty body (no blueprint for this typeId) — not a real error,
      // and is a definitive "not a blueprint" signal — persist to IDB.
      if (err instanceof SyntaxError) {
        return persistNull();
      }
      // Any other error (network, timeout) is transient — memory-only so next load retries.
      console.error(
        `[mfg] getMaterialRecord error for typeId ${blueprintTypeId}:`,
        err,
      );
      this.materialMemCache.set(blueprintTypeId, null);
      return null;
    }
  }
}

export const manufacturingService = new ManufacturingService();
