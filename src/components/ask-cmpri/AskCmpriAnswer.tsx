import type { AskRecordReference, AskResponse, AskResultItem, AskTable } from "@/lib/ask-cmpri/types";

type OpenRecord = (record: AskRecordReference) => void;

function safePublicHref(href?: string) {
  try {
    const url = new URL(href || "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

function RecordLink({ record, openRecord, label }: { record: AskRecordReference; openRecord: OpenRecord; label?: string }) {
  return <button className="ask-text-action" type="button" onClick={() => openRecord(record)}>{label || record.label || "Open record"}</button>;
}

function SourceLink({ href, label }: { href?: string; label: string }) {
  const safe = safePublicHref(href);
  return safe ? <a className="ask-text-action" href={safe} target="_blank" rel="noopener noreferrer">{label}</a> : null;
}

function ItemLinks({ item, openRecord }: { item: AskResultItem; openRecord: OpenRecord }) {
  const links = item.links || [];
  const records = item.record && !links.some(link => link.kind === item.record?.kind && link.id === item.record.id) ? [item.record, ...links] : links;
  if (!records.length && !item.href) return null;
  return <div className="ask-hit-links">
    {records.map(record => <RecordLink key={record.kind + ":" + record.id} record={record} openRecord={openRecord} />)}
    {item.href && <SourceLink href={item.href} label={item.hrefLabel || "Open source"} />}
  </div>;
}

function ResultItem({ item, openRecord }: { item: AskResultItem; openRecord: OpenRecord }) {
  return <li className="ask-hit">
    <h4>{item.title}</h4>
    {item.text && <p>{item.text}</p>}
    {!!item.facts?.length && <dl>{item.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
    <p className="ask-source-label" data-source={item.sourceType}>{item.source}</p>
    <ItemLinks item={item} openRecord={openRecord} />
  </li>;
}

function ResultsTable({ table, title, openRecord }: { table: AskTable; title: string; openRecord: OpenRecord }) {
  const caption = table.caption || title;
  return <div className="ask-result-table-scroll" role="region" aria-label={caption} tabIndex={0}>
    <table className="ask-result-table">
      <caption className="sr-only">{caption}</caption>
      <thead><tr>{table.columns.map(column => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
      <tbody>{table.rows.map(row => <tr key={row.id}>
        {table.columns.map(column => {
          const cell = row.cells[column.id];
          return <td key={column.id} data-column-id={column.id.toLowerCase().replace(/ +/g, "-")}>
            {!cell ? "—" : typeof cell === "string" ? cell : <>
              {cell.record ? <RecordLink record={cell.record} openRecord={openRecord} label={cell.text} />
                : safePublicHref(cell.href) ? <SourceLink href={cell.href} label={cell.text} /> : cell.text}
              {!!cell.links?.length && <div className="ask-hit-links">{cell.links.map(record =>
                <RecordLink key={record.kind + ":" + record.id} record={record} openRecord={openRecord} />)}</div>}
            </>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function AskCmpriAnswer({ result, openRecord }: { result: AskResponse; openRecord: OpenRecord }) {
  return <div className="ask-answer">
    {result.title && <h3>{result.title}</h3>}
    {result.summary && <p className="ask-answer-copy">{result.summary}</p>}
    {result.table ? <ResultsTable table={result.table} title={result.title} openRecord={openRecord} />
      : result.format !== "brief" && !!result.items?.length && <ul className="ask-result-list" data-format={result.format}>
        {result.items.map(item => <ResultItem key={item.id} item={item} openRecord={openRecord} />)}
      </ul>}
    {result.format === "brief" && !result.table && result.items?.some((item) => item.record || item.href || item.links?.length) &&
      <ul className="ask-result-list" data-format="brief">{result.items.filter((item) => item.record || item.href || item.links?.length).map((item) =>
        <li key={item.id}><p className="ask-source-label" data-source={item.sourceType}>{item.source}</p><ItemLinks item={item} openRecord={openRecord} /></li>)}</ul>}
  </div>;
}
