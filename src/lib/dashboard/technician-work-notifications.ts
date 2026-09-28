export type TechnicianWorkAlertOrder = {
  id: string;
  technician_name: string | null;
};

export function newlyAvailableTechnicianWork<T extends TechnicianWorkAlertOrder>(
  previousOrders: ReadonlyMap<string, string> | null,
  fetchedOrders: T[],
  technicianName?: string | null,
) {
  if (!previousOrders) return [];
  const currentTechnicianName = technicianName?.trim() || "";
  return fetchedOrders.filter((order) => {
    const previousTechnician = previousOrders.get(order.id);
    const assignedTechnician = order.technician_name?.trim() || "";
    if (assignedTechnician && assignedTechnician !== currentTechnicianName) return false;
    return previousTechnician === undefined || (!previousTechnician && !!assignedTechnician);
  });
}
