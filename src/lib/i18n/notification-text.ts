/** Translate only known CMPRI-generated notification framing, never its quoted details. */
type Translate = (english: string, values?: Record<string, string | number>) => string;
export function translateNotificationMessage(message: string, t: Translate): string {
  let match: RegExpMatchArray | null;
  const order = '(WO#\\d+|Work order)';
  if ((match = message.match(new RegExp('^' + order + ' was reopened and reassigned to you\\.$'))))
    return t('{order} was reopened and reassigned to you.', { order: match[1] === 'Work order' ? t('Work order') : match[1] });
  if ((match = message.match(new RegExp('^' + order + ' was assigned to you\\.$'))))
    return t('{order} was assigned to you.', { order: match[1] === 'Work order' ? t('Work order') : match[1] });
  if ((match = message.match(new RegExp('^' + order + ': Claimed by Engineer$'))))
    return t('{order}: Claimed by Engineer', { order: match[1] === 'Work order' ? t('Work order') : match[1] });
  if ((match = message.match(new RegExp('^' + order + ' was claimed by (.+)\\.$'))))
    return t('{order} was claimed by {name}.', { order: match[1] === 'Work order' ? t('Work order') : match[1], name: match[2] });
  if ((match = message.match(new RegExp('^' + order + ' viewed awaiting satisfying\\.$'))))
    return t('{order} viewed awaiting satisfying.', { order: match[1] === 'Work order' ? t('Work order') : match[1] });
  if ((match = message.match(new RegExp('^' + order + ' \\((.*)\\) status changed: (.+?) → (.+?) by (.+)\\.$'))))
    return t('{order} ({details}) status changed: {from} → {to} by {name}.', {
      order: match[1] === 'Work order' ? t('Work order') : match[1], details: match[2], from: t(match[3]), to: t(match[4]), name: match[5],
    });
  if ((match = message.match(/^New (WO#\d+): (.*)$/)))
    return t('New {order}: {details}', { order: match[1], details: match[2] });
  if ((match = message.match(/^Draft — awaiting approval: (.*)$/)))
    return t('Draft — awaiting approval: {details}', { details: match[1] });
  return message;
}
