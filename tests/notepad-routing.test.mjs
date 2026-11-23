import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNotepadPath, notepadTargetId, notepadLayoutKey } from "../src/lib/ui/notepad-navigation.ts";
import { dashboardMenuGroups } from "../src/lib/dashboard/menu-groups.ts";
import { anchoredHeaderLayoutForGroups } from "../src/lib/header-layout.ts";
import { canResumeWorkspaceView } from "../src/lib/ui/workspace-route-access.ts";
import { desktopWindowKeyForHref, isAskRecordRoute } from "../src/lib/ui/desktop-windows.ts";
import { modalActionForRoute, headerActionStyle } from "../src/lib/ui/header-palette.ts";

const origin = "https://cmpri.test";
const id = "b9c12f09-608b-4504-a55a-d44f27d35ec6";
const session = { user: { id: "current", role: "front_desk" }, hotelId: "property", capabilities: [] };

test("Notepad and both retired URLs resolve the original note target and retain authenticated workspace access", () => {
  for (const path of ["/notepad", "/notes", "/staff-notes"]) {
    assert.equal(isNotepadPath(path), true);
    assert.equal(notepadTargetId(new URL(path + "?note=" + id, origin)), id);
    assert.equal(notepadTargetId(new URL(path + "#note-" + id, origin)), id);
    assert.equal(canResumeWorkspaceView(session, { kind: "frame", key: path, href: path }), true);
    assert.equal(canResumeWorkspaceView({ ...session, hotelId: "" }, { kind: "frame", key: path, href: path }), false);
    assert.equal(desktopWindowKeyForHref(path + "?note=" + id, origin), path + "?note=" + id);
    assert.equal(isAskRecordRoute(path + "?note=" + id, origin), true);
    assert.equal(modalActionForRoute(path), "Notepad");
  }
  assert.equal(notepadTargetId(new URL("/profile?note=" + id, origin)), undefined);
  assert.equal(notepadTargetId(new URL("/notepad#note-%E0%A4", origin)), undefined);
  assert.equal(notepadTargetId(new URL("/notepad?note=../private", origin)), undefined);
  assert.equal(isAskRecordRoute("https://other.test/notepad?note=" + id, origin), false);
  assert.deepEqual(headerActionStyle("Notepad"), headerActionStyle("Staff Notes"), "Notepad retains the existing CMPRI palette color");
});

test("each role menu offers one Notepad and legacy saved note positions collapse into that launcher", () => {
  const actions = [
    { key: "/notepad", label: "Notepad" }, { key: "/notes", label: "Notes" }, { key: "/staff-notes", label: "Staff Notes" },
    { key: "sign-out", label: "Sign Out" }, { key: "/profile", label: "Manage Profile" },
  ];
  for (const role of ["engineer", "technician", "manager", "front_desk", "housekeeping", "system_admin"]) {
    const groups = dashboardMenuGroups(role, actions);
    const notebooks = groups.flatMap(group => group.items).filter(action => isNotepadPath(action.key));
    assert.deepEqual(notebooks, [{ key: "/notepad", label: "Notepad" }], role);
  }
  const groups = dashboardMenuGroups("engineer", actions);
  const oldKeys = ["/profile::Manage Profile", "/notes::Notes", "/staff-notes::Staff Notes"];
  const mapped = [...new Set(oldKeys.map(notepadLayoutKey))];
  assert.deepEqual(mapped, ["/profile::Manage Profile", "/notepad::Notepad"]);
  const restored = anchoredHeaderLayoutForGroups({ groups: groups.map(group => group.label), buttons: { "Daily Work": mapped }, positions: { "Daily Work": 0 } }, groups, null);
  assert.equal(restored.groups.flatMap(group => group.items).filter(action => action.key === "/notepad").length, 1);
  assert.equal(restored.groups.find(group => group.label === "Daily Work").items.at(-1).key, "/notepad");
});

test("retired page entry points render the shared Notepad instead of maintaining independent notebooks", () => {
  for (const path of ["notes", "staff-notes"]) {
    const source = readFileSync(new URL(`../src/app/${path}/page.tsx`, import.meta.url), "utf8");
    assert.match(source, /export \{ default \} from "\.\.\/notepad\/page"/);
    assert.doesNotMatch(source, /components\/(?:StaffNotes|GeneralNotes)/);
  }
});
