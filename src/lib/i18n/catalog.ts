import { COMMON_ES } from './common';
import { COMBINED_MENUS_ES } from './combined-menus';
import { COMBINED_EXTRA_ES } from './combined-extra';
import { SHELL_ES } from './shell';
import { PROFILE_WORK_ORDERS_ES } from './profile-work-orders';
import { TICKET_MEDIA_ES } from './ticket-media';
import { OPERATIONS_ES } from './operations';
import { MANAGEMENT_ES } from './management';
import { PUBLIC_ES } from './public';
import { WEATHER_ES } from './weather';

/** Shared terms take precedence so the same control has the same wording everywhere. */
export const SPANISH_UI: Readonly<Record<string, string>> = Object.freeze({
  ...SHELL_ES, ...PROFILE_WORK_ORDERS_ES, ...TICKET_MEDIA_ES,
  ...OPERATIONS_ES, ...MANAGEMENT_ES, ...PUBLIC_ES, ...WEATHER_ES, ...COMBINED_MENUS_ES, ...COMBINED_EXTRA_ES, ...COMMON_ES,
});
