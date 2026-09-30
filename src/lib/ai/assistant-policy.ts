export type AssistantCapabilities = {
  viewDashboard: boolean;
  submit: boolean;
  editTickets: boolean;
  reviewTickets: boolean;
  manageAssets: boolean;
  operateIntegrations: boolean;
};

export function assistantPolicy(capabilities: AssistantCapabilities, equipment: { canRead: boolean; canEdit: boolean; assignedWorkOnly: boolean }) {
  const canViewDashboard = capabilities.viewDashboard;
  const canEditTickets = capabilities.editTickets;
  const canReviewTickets = capabilities.reviewTickets;
  return {
    readAllWorkOrders: canViewDashboard && !equipment.assignedWorkOnly,
    readAssignedWorkOrders: canEditTickets && equipment.assignedWorkOnly,
    readOwnWorkOrders: capabilities.submit && !canViewDashboard && !canEditTickets,
    createWorkOrders: capabilities.submit,
    updateWorkOrders: canEditTickets || canReviewTickets,
    importRoomOperations: canEditTickets,
    readEquipment: equipment.canRead,
    manageEquipment: capabilities.manageAssets && equipment.canEdit,
    readPm: canViewDashboard,
    updatePm: capabilities.operateIntegrations,
    readReports: canViewDashboard,
  };
}