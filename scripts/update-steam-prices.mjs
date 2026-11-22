#!/usr/bin/env node
// Weekly best-effort Saudi Steam store price refresh.
// Missing or non-SAR prices are NEVER fabricated. The previous verified price is retained.
import fs from "node:fs/promises";
import path from "node:path";

const ids = [1966720, 2827200, 3949040, 4656000, 3712080, 4108000, 1326470, 5053820, 4948000, 4412320, 3527290, 2644470, 2709570, 3241660, 728880, 2567870, 2881650];
const file = path.join(process.cwd(), "src", "steamPrices.json");
const existing = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
const result = { ...existing };
let successes = 0;

for (const id of ids) {
  try {
    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.searchParams.set("appids", String(id));
    url.searchParams.set("cc", "sa");
    url.searchParams.set("l", "english");
    const response = await fetch(url, { headers: { "User-Agent": "CoOpCatalogPriceCheck/1.0" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const item = (await response.json())?.[String(id)];
    if (!item?.success) throw new Error("No store details");
    const game = item.data;
    const when = new Date().toISOString();
    if (game?.is_free === true) {
      result[id] = { price: 0, old: 0, checkedAt: when, currency: "SAR", free: true };
      successes++;
    } else if (game?.price_overview?.currency === "SAR") {
      const price = game.price_overview;
      if (!Number.isInteger(price.final) || price.final < 0) throw new Error("Invalid price");
      result[id] = {
        price: price.final / 100,
        old: Number.isInteger(price.initial) ? price.initial / 100 : price.final / 100,
        checkedAt: when, currency: "SAR"
      };
      successes++;
    } else {
      console.log(id + ": no confirmed SAR price; keeping previous value");
    }
  } catch (err) {
    console.warn("Price check failed for " + id + ": " + err.message);
  }
}
if (successes === 0) {
  console.log("No prices confirmed; not overwriting file.");
  process.exit(0);
}
await fs.writeFile(file, JSON.stringify(result, null, 2) + "\n");
console.log("Verified Steam Saudi prices updated: " + successes + "/" + ids.length);
