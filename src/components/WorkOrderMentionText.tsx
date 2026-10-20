import PlainTextLinks from "@/components/PlainTextLinks";
import { workOrderStaffMentions, type WorkOrderMention } from "@/lib/work-order-mentions";

export default function WorkOrderMentionText({ text, mentions }: { text: string; mentions: readonly WorkOrderMention[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const match of workOrderStaffMentions(text, mentions)) {
    parts.push(<PlainTextLinks key={`text-${at}`} text={text.slice(at, match.start)} />);
    parts.push(<span key={`staff-${match.start}`} data-work-order-mention={match.mention.kind} className="rounded bg-sky-400/10 font-semibold text-sky-300">{text.slice(match.start, match.end)}</span>);
    at = match.end;
  }
  parts.push(<PlainTextLinks key={`text-${at}`} text={text.slice(at)} />);
  return <>{parts}</>;
}
