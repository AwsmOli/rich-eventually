import { readFileSync, writeFileSync } from 'fs';

const filePath = 'src/services/ordersService.ts';
const content = readFileSync(filePath, 'utf8');
const lines = content.split('\n');

// Find the start line (1-indexed) of computeInventory and the "// ── Mapping" line
let startLine = -1;
let endLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('private computeInventory(') && startLine === -1) startLine = i;
  if (lines[i].includes('// \u2500\u2500 Mapping') && startLine !== -1 && endLine === -1) endLine = i;
}

console.log(`Replacing lines ${startLine + 1}–${endLine} (0-indexed ${startLine}–${endLine - 1})`);

const newFn = `  private computeInventoryFromAssets(
    assets: EsiAsset[],
    txns: EsiTransaction[],
    openOrders: CharacterOrder[],
    historyOrders: CharacterOrder[],
  ): InventoryItem[] {
    // Build locationId -> regionId map from character's orders.
    const locationRegion = new Map<number, number>();
    for (const o of [...openOrders, ...historyOrders]) {
      locationRegion.set(o.locationId, o.regionId);
    }

    // Only consider stackable items sitting directly in a station/structure hangar.
    // Assembled (singleton) items cannot be directly sold, so skip them.
    const hangarItems = assets.filter(
      (a) => a.location_flag === 'Hangar' && !a.is_singleton,
    );

    // Items currently listed on open sell orders per (typeId:locationId).
    const listedQty = new Map<string, number>();
    for (const o of openOrders) {
      if (o.isBuyOrder) continue;
      const key = \`\${o.typeId}:\${o.locationId}\`;
      listedQty.set(key, (listedQty.get(key) ?? 0) + o.volumeRemain);
    }

    // Build weighted avg buy price and last buy date per typeId from transactions.
    type BuyInfo = { totalCost: number; totalQty: number; lastDate: string };
    const buyInfo = new Map<number, BuyInfo>();
    for (const t of txns) {
      if (!t.is_buy) continue;
      let b = buyInfo.get(t.type_id);
      if (!b) {
        b = { totalCost: 0, totalQty: 0, lastDate: t.date };
        buyInfo.set(t.type_id, b);
      }
      b.totalCost += t.unit_price * t.quantity;
      b.totalQty += t.quantity;
      if (t.date > b.lastDate) b.lastDate = t.date;
    }

    const result: InventoryItem[] = [];
    for (const asset of hangarItems) {
      const listed = listedQty.get(\`\${asset.type_id}:\${asset.location_id}\`) ?? 0;
      const unlistedQty = asset.quantity - listed;
      if (unlistedQty <= 0) continue;

      const info = buyInfo.get(asset.type_id);
      const avgBuyPrice =
        info && info.totalQty > 0 ? info.totalCost / info.totalQty : 0;
      const lastBuyDate = info?.lastDate ?? new Date(0).toISOString();

      result.push({
        typeId: asset.type_id,
        typeName: this.nameCache.get(asset.type_id) ?? \`Type \${asset.type_id}\`,
        locationId: asset.location_id,
        regionId: locationRegion.get(asset.location_id),
        qty: unlistedQty,
        avgBuyPrice,
        totalCost: avgBuyPrice * unlistedQty,
        lastBuyDate,
      });
    }

    return result.sort((a, b) => b.totalCost - a.totalCost);
  }

`;

const before = lines.slice(0, startLine);
const after = lines.slice(endLine);
const newContent = [...before, newFn, ...after].join('\n');
writeFileSync(filePath, newContent);
console.log('done');
