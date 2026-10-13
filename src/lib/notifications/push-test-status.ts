export type PushTest = {
  id: string;
  status: "pending" | "sending" | "accepted" | "failed" | "cancelled" | "expired" | "blocked" | "unknown";
  due_at: string;
  expires_at: string;
};

export function pushTestMessage(test: PushTest) {
  switch (test.status) {
    case "pending": return "Test scheduled for this device. You can lock your phone. Delivery timing may vary.";
    case "sending": return "Sending test to this device…";
    case "accepted": return "Test accepted by the push service. Check your phone; this does not confirm device receipt.";
    case "cancelled": return "Test cancelled.";
    case "blocked": return "Test not sent: notification hours or this device’s eligibility changed.";
    case "expired": return "Test expired without being sent. You can request another test.";
    case "unknown": return "Test result is unknown. Check your phone before requesting another test; it will not be resent automatically.";
    case "failed": return "The push service rejected the test. Check this device’s notification registration.";
  }
}
