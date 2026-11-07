import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("../src/components/TroubleshootingGuideDropdown.tsx", import.meta.url), "utf8");
const workOrderForm = readFileSync(new URL("../src/app/work-orders/page.tsx", import.meta.url), "utf8");

test("guide printing hides dashboard content only while a guide portal is open", () => {
  const styles = readFileSync(new URL("../src/components/TroubleshootingGuideDropdown.module.css", import.meta.url), "utf8");
  assert.match(styles, /@media print\s*\{\s*:global\(body\):has\(> \.printRoot\) > :not\(\.printRoot\)\s*\{\s*display: none !important/);
  assert.doesNotMatch(styles, /:global\(body\)\s*>\s*:not\(\.printRoot\)/);
});

test("Troubleshooting Guide menu has exactly the three requested guide choices", () => {
  const options = component.match(/const GUIDE_OPTIONS:[\s\S]*?];/)?.[0] || "";
  const titles = [...options.matchAll(/title: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(titles, [
    "Enseo TV Troubleshooting Guide",
    "Dormakaba LED Visual Guide",
    "Guest Room Troubleshooting Guide",
  ]);
});

test("Dormakaba guide retains all 22 source entry identifiers in the three sections", () => {
  const codes = [...component.matchAll(/code: "(N\d{2}|S\d{2}|I\d{2})"/g)].map((match) => match[1]);
  assert.deepEqual(codes, [
    "N01", "N02", "N03", "N04", "N05", "N06", "N07",
    "S01", "S02", "S03", "S04", "S05", "S06",
    "I01", "I02", "I03", "I04", "I05", "I06", "I07", "I08", "I09",
  ]);
  assert.match(component, /Source notes:[\s\S]*S04 does not separately define the Yellow count or timing/);
  assert.match(component, /Reused signals:[\s\S]*I04 and I06 have the same pattern and different meanings/);
});

test("Guest Room guide includes English and Spanish and the guides are rendered as HTML", () => {
  assert.match(component, /className=\{styles\.eyebrow\} lang="en">English/);
  assert.match(component, /className=\{styles\.eyebrow\}>Español/);
  assert.match(component, /Guía de Resolución de Problemas para Habitaciones de Huéspedes/);
  assert.match(component, /<GuidePdfViewer key=\{selected.id\} src=\{selected.href\}/);
});

test("all required timing and numeric details are present in the HTML guide content", () => {
  for (const value of [
    "866-717-3075",
    "1-866-717-3075",
    "5-second delay",
    "30 seconds",
    "7 minutes",
    "20 seconds",
    "65°F",
    "80°F",
    "1–2 minutes",
    "HDMI 1",
    "12 flashes",
  ]) {
    assert.ok(component.includes(value), `missing ${value}`);
  }
});

test("work-order technical guidance never falls back to generic checks", () => {
  assert.match(workOrderForm, /trustedTroubleshootingKnowledge\?\.symptom_rules/);
  assert.match(workOrderForm, /No issue-matched troubleshooting steps from verified documentation are available/);
  assert.doesNotMatch(workOrderForm, /GENERAL_TROUBLESHOOTING_CHECKS|Generic troubleshooting/);
});

test("native guide dropdown opens exactly the three local PDF exports", () => {
  assert.match(component, /<select[\s\S]*aria-label="Front Desk Quick Guides"/);
  assert.doesNotMatch(component, /window.open/);
  assert.match(component, /dialogRef.current.showModal\(\)/);
  assert.doesNotMatch(component, /Back to guides/); // One dismiss control in the viewer header.
  assert.match(component, /aria-label="Close guide"/);
  assert.doesNotMatch(component, /aria-haspopup="menu"/);
  for (const slug of ["enseo", "dormakaba", "guest-room"]) {
    assert.ok(component.includes(`/guides/${slug}.pdf`));
    assert.equal(readFileSync(new URL(`../public/guides/${slug}.pdf`, import.meta.url)).subarray(0,5).toString(), "%PDF-");
  }
});
