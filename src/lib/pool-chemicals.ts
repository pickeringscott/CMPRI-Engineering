/** Pool usage is staged locally and committed with the pool log, never on selection. */
export type PoolChemicalUse = { id: string; item: string; quantity: number; unit: string };
export type PoolSupply = { id: string; item_name: string; quantity_on_hand: number; quantity_reserved: number; unit_of_measure: string };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function poolChemicalUses(value: unknown): PoolChemicalUse[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw Error('Submit up to 100 chemical usages per save.');
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') throw Error('Invalid chemical usage.');
    const {id,item,quantity,unit} = entry;
    if (typeof id !== 'string' || !uuid.test(id) || ids.has(id) || typeof item !== 'string' || !uuid.test(item)
      || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999
      || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.0001
      || typeof unit !== 'string' || !unit.trim() || unit.length > 40) throw Error('Choose a chemical, a positive quantity (up to three decimal places), and its unit.');
    ids.add(id);
    return {id,item,quantity,unit:unit.trim()};
  });
}
export function chemicalRemark(use: PoolChemicalUse, name: string) {
  return `Chemical used: ${use.quantity} ${use.unit} ${name}.`;
}
