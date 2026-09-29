export type TechnicianWorkAlertOrder = {
  id: string;
  technician_name: string | null;
};

export function newlyAvailableTechnicianWork<T extends TechnicianWorkAlertOrder>(
  previousOrders: ReadonlyMap<string, string> | null,
  fetchedOrders: T[],
) {
  if (!previousOrders) return [];
  return fetchedOrders.filter((order) => {
    const previousTechnician = previousOrders.get(order.id);
    const assignedTechnician = order.technician_name?.trim() || "";
    if (assignedTechnician) return false;
    if (previousTechnician === undefined) return true;
    return !!previousTechnician && !assignedTechnician;
  });
}
