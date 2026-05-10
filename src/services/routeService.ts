import type {
  RouteDetails,
  RouteSecurityPreference,
  RouteSecuritySquare,
} from "../types/domain";
import { isMockModeEnabled } from "../utils/mockData";
import { getEveSecurityColor } from "../utils/securityColors";
import { esiApiService } from "./esiApiService";
import { kvGet, kvSet } from "./idbService";
import { marketDataService } from "./marketDataService";

const ROUTE_CACHE_KEY = "rich-eventually-route-cache";

class RouteService {
  private readonly routeCache = new Map<string, RouteDetails>();

  constructor() {
    // Restore route cache from IDB asynchronously on startup.
    void kvGet<Array<[string, RouteDetails]>>(ROUTE_CACHE_KEY).then(
      (entries) => {
        if (entries) {
          for (const [k, v] of entries) this.routeCache.set(k, v);
        }
      },
    );
  }

  public async getRoute(
    origin: number,
    destination: number,
    avoidSystemIds: number[],
    preference: RouteSecurityPreference,
  ): Promise<RouteDetails> {
    if (isMockModeEnabled()) {
      const [originDetails, destDetails] = await Promise.all([
        marketDataService.getSystemDetails(origin),
        marketDataService.getSystemDetails(destination),
      ]);
      const squares = this.buildSecuritySquares([destDetails]);

      return {
        systems: [origin, destination],
        jumps: 1,
        squares,
        originName: originDetails.name,
        destinationName: destDetails.name,
      };
    }

    const cacheKey = `${origin}:${destination}:${avoidSystemIds.sort().join("-")}:${preference}`;
    const cached = this.routeCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    // Same-system trade — no ESI call needed, 0 jumps.
    if (origin === destination) {
      const systemDetails = await marketDataService.getSystemDetails(origin);
      const details: RouteDetails = {
        systems: [origin],
        jumps: 0,
        squares: [],
        originName: systemDetails.name,
        destinationName: systemDetails.name,
      };
      this.routeCache.set(cacheKey, details);
      this.persistRouteCache();
      return details;
    }

    const routeSystems = await esiApiService.execute("Get route", async () =>
      esiApiService.routesApi.getRouteOriginDestination({
        origin,
        destination,
        avoid: new Set(avoidSystemIds),
        flag: preference,
        datasource: "tranquility",
      }),
    );

    const systemDetails = await Promise.all(
      routeSystems.map((id) => marketDataService.getSystemDetails(id)),
    );
    const squares = this.buildSecuritySquares(systemDetails.slice(1));

    const details: RouteDetails = {
      systems: routeSystems,
      jumps: Math.max(0, routeSystems.length - 1),
      squares,
      originName: systemDetails[0]?.name ?? "",
      destinationName: systemDetails[systemDetails.length - 1]?.name ?? "",
    };

    this.routeCache.set(cacheKey, details);
    this.persistRouteCache();
    return details;
  }

  private persistRouteCache(): void {
    void kvSet(ROUTE_CACHE_KEY, [...this.routeCache.entries()]);
  }

  private buildSecuritySquares(
    points: Array<{ systemId: number; name: string; securityStatus: number }>,
  ): RouteSecuritySquare[] {
    return points.map((point) => ({
      systemId: point.systemId,
      systemName: point.name,
      securityStatus: point.securityStatus,
      color: this.toSecurityColor(point.securityStatus),
    }));
  }

  private toSecurityColor(securityStatus: number): string {
    return getEveSecurityColor(securityStatus);
  }
}

export const routeService = new RouteService();
