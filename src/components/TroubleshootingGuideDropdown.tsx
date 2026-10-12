"use client";

import styles from "./TroubleshootingGuideDropdown.module.css";

type GuideId = "enseo" | "dormakaba" | "guest-room";

const GUIDE_OPTIONS: Array<{ id: GuideId; title: string; href: string }> = [
  { id: "enseo", title: "Enseo TV Troubleshooting Guide", href: "/guides/enseo.pdf" },
  { id: "dormakaba", title: "Dormakaba LED Visual Guide", href: "/guides/dormakaba.pdf" },
  { id: "guest-room", title: "Guest Room Troubleshooting Guide", href: "/guides/guest-room.pdf" },
];

type LedColor = "G" | "Y" | "R";
type SignalGroup = {
  colors: LedColor[];
  detail: string;
  colorRelation?: "plus" | "simultaneous";
};
type Signal = {
  groups: SignalGroup[];
  connector?: "then" | "alternating" | "plus";
};
type DormakabaEntry = {
  code: string;
  pattern: Signal;
  patternText: string;
  meaning: string;
  explanation: string;
  urgency: string;
  nextStep: string;
  note?: string;
};

const NORMAL_ENTRIES: DormakabaEntry[] = [
  {
    code: "N01",
    pattern: { groups: [{ colors: ["G"], detail: "12 flashes" }] },
    patternText: "Green (Flashes 12x)",
    meaning: "Access Granted",
    explanation: "Normal operation.",
    urgency: "None",
    nextStep: "Normal operation",
  },
  {
    code: "N02",
    pattern: { groups: [{ colors: ["Y"], detail: "12 flashes" }] },
    patternText: "Yellow (Flashes 12x)",
    meaning: "Deadbolt / Privacy Switch Is On",
    explanation: "Room is occupied or locked from the inside.",
    urgency: "Low",
    nextStep: "Check with guest",
  },
  {
    code: "N03",
    pattern: { groups: [{ colors: ["Y"], detail: "8 flashes" }] },
    patternText: "Yellow (Flashes 8x)",
    meaning: "Access Denied",
    explanation: "Keycard is expired, wrong room, or blocked.",
    urgency: "Low",
    nextStep: "Re-make keycard",
  },
  {
    code: "N04",
    pattern: {
      groups: [
        { colors: ["Y"], detail: "Yellow" },
        { colors: ["R"], detail: "Red" },
        { colors: ["Y"], detail: "Yellow" },
        { colors: ["R"], detail: "Red" },
      ],
      connector: "then",
    },
    patternText: "Yellow then Red, Yellow then Red",
    meaning: "Battery is Low (Mid-Level)",
    explanation: "The lock has entered an early warning power state.",
    urgency: "Medium",
    nextStep: "Replace batteries soon",
  },
  {
    code: "N05",
    pattern: {
      groups: [
        { colors: ["G"], detail: "Green" },
        { colors: ["R"], detail: "Red" },
      ],
      connector: "alternating",
    },
    patternText: "Green and Red (Alternating)",
    meaning: "Battery is Critically Low",
    explanation: "The lock is about to die completely.",
    urgency: "High",
    nextStep: "Replace batteries immediately",
  },
  {
    code: "N06",
    pattern: { groups: [{ colors: ["R"], detail: "Simultaneous flashes*" }] },
    patternText: "Red (Simultaneous Flashes)",
    meaning: "Lock Clock Reset",
    explanation: "The lock's internal clock lost its time.",
    urgency: "High",
    nextStep: "Reprogram lock with LPI/MKO probe",
    note: "* The source wording is retained. It does not name another LED or specify a count.",
  },
  {
    code: "N07",
    pattern: { groups: [{ colors: [], detail: "No lights at all" }] },
    patternText: "No Lights at All",
    meaning: "Dead Batteries / Broken Lock",
    explanation: "The lock has completely lost power or is physically broken.",
    urgency: "Critical",
    nextStep: "Emergency mechanical key needed",
  },
];

const SPECIAL_ENTRIES: DormakabaEntry[] = [
  {
    code: "S01",
    pattern: {
      groups: [
        { colors: ["G", "Y", "R"], detail: "1 flash each; order not stated" },
        { colors: ["G", "Y", "R"], detail: "4 flashes" },
      ],
      connector: "then",
    },
    patternText: "1 Green, 1 Yellow, 1 Red (then all 3 flash 4x)",
    meaning: "Fatal Test Mode (Lock E2 failed)",
    explanation: "Drill the lock to open.",
    urgency: "Critical",
    nextStep: "Destructive entry required",
    note: "The source lists one flash of each color before the ×4 group; it does not state the order within that first group.",
  },
  {
    code: "S02",
    pattern: { groups: [{ colors: ["R", "G", "Y"], detail: "4 simultaneous flashes", colorRelation: "simultaneous" }] },
    patternText: "Red, Green, Yellow (Simultaneous flash 4x)",
    meaning: "MODE 0: Circuit board problem",
    explanation: "Use E2 erase keycard to enter Mode 1 and reprogram.",
    urgency: "High",
    nextStep: "Maintenance needed",
  },
  {
    code: "S03",
    pattern: {
      groups: [
        { colors: ["G"], detail: "2 flashes" },
        { colors: ["G", "Y", "R"], detail: "4 flashes" },
      ],
      connector: "then",
    },
    patternText: "Green 2x (then all 3 flash 4x)",
    meaning: "MODE 1: Lock not programmed",
    explanation: "Reprogram using the LPI probe.",
    urgency: "High",
    nextStep: "Maintenance needed",
  },
  {
    code: "S04",
    pattern: {
      groups: [
        { colors: ["G", "Y"], detail: "2 Green + Yellow flashes", colorRelation: "plus" },
        { colors: ["G", "Y", "R"], detail: "4 flashes" },
      ],
      connector: "then",
    },
    patternText: "2 Green + Yellow flashes (then all 3 flash 4x)",
    meaning: "MODE 3: Programming chip problem",
    explanation: "Replace the circuit board.",
    urgency: "Critical",
    nextStep: "Hardware replacement",
    note: "The source preserves “2 Green + Yellow flashes.” It does not separately define the Yellow count or timing.",
  },
  {
    code: "S05",
    pattern: {
      groups: [
        { colors: ["R"], detail: "2 flashes" },
        { colors: ["G", "Y", "R"], detail: "4 flashes" },
      ],
      connector: "then",
    },
    patternText: "2 Red flashes (then all 3 flash 4x)",
    meaning: "MODE 4: Lock E2 disabled",
    explanation: "Use PPK + E2 disable/enable keycard to re-enable.",
    urgency: "High",
    nextStep: "Maintenance needed",
  },
  {
    code: "S06",
    pattern: {
      groups: [
        { colors: ["Y"], detail: "2 flashes" },
        { colors: ["G", "Y", "R"], detail: "4 flashes" },
        { colors: ["Y"], detail: "Slow yellow flash" },
      ],
      connector: "then",
    },
    patternText: "2 Yellow flashes (then all 3 flash 4x then slow yellow flash)",
    meaning: "MODE 5: Motor jammed / switch problem",
    explanation: "Replace the entire lockset.",
    urgency: "Critical",
    nextStep: "Hardware replacement",
  },
];

const INVALID_MODE_ENTRIES: DormakabaEntry[] = [
  {
    code: "I01",
    pattern: { groups: [{ colors: ["G", "Y"], detail: "6 flashes", colorRelation: "plus" }] },
    patternText: "Green + Yellow (Flashes 6x)",
    meaning: "Resequence Completed",
    explanation: "New keycard sequence accepted successfully.",
    urgency: "None",
    nextStep: "",
  },
  {
    code: "I02",
    pattern: { groups: [{ colors: ["Y"], detail: "6 flashes" }] },
    patternText: "Yellow (Flashes 6x)",
    meaning: "Lock Not Out of Sequence",
    explanation: "Lock was already on the correct sequence.",
    urgency: "None",
    nextStep: "",
  },
  {
    code: "I03",
    pattern: {
      groups: [
        { colors: ["R"], detail: "1 flash" },
        { colors: [], detail: "Sequence" },
      ],
      connector: "then",
    },
    patternText: "Red 1x (Before a sequence)",
    meaning: "Resequence Failed",
    explanation: "Keycard sequence error.",
    urgency: "Low",
    nextStep: "Issue a new keycard",
  },
  {
    code: "I04",
    pattern: {
      groups: [
        { colors: ["R"], detail: "1 flash" },
        { colors: ["Y"], detail: "12 flashes" },
      ],
      connector: "plus",
    },
    patternText: "Red 1x + 12 Yellow flashes",
    meaning: "Lock Successfully Inhibited",
    explanation: "Guest-level keycards are now disabled.",
    urgency: "None",
    nextStep: "Normal if intentional",
  },
  {
    code: "I05",
    pattern: { groups: [{ colors: ["Y"], detail: "12 flashes" }] },
    patternText: "Yellow (Flashes 12x)",
    meaning: "Lock Already Inhibited",
    explanation: "Lock was already in an inhibited state.",
    urgency: "None",
    nextStep: "",
  },
  {
    code: "I06",
    pattern: {
      groups: [
        { colors: ["R"], detail: "1 flash" },
        { colors: ["Y"], detail: "12 flashes" },
      ],
      connector: "plus",
    },
    patternText: "Red 1x + 12 Yellow flashes",
    meaning: "Electronic Lockout Enabled",
    explanation: "All lower-tier access blocked.",
    urgency: "None",
    nextStep: "Normal if intentional",
  },
  {
    code: "I07",
    pattern: {
      groups: [
        { colors: ["G"], detail: "1 flash" },
        { colors: ["Y"], detail: "12 flashes" },
      ],
      connector: "plus",
    },
    patternText: "Green 1x + 12 Yellow flashes",
    meaning: "Electronic Lockout Removed",
    explanation: "Normal room access restored.",
    urgency: "None",
    nextStep: "",
  },
  {
    code: "I08",
    pattern: { groups: [{ colors: ["Y"], detail: "Flashes for 20 seconds" }] },
    patternText: "Yellow (Flashes for 20 seconds)",
    meaning: "Programming Active",
    explanation: "Primary / Secondary Program card accepted.",
    urgency: "Low",
    nextStep: "Proceed with programming",
  },
  {
    code: "I09",
    pattern: { groups: [{ colors: ["Y", "G"], detail: "2 flashes", colorRelation: "plus" }] },
    patternText: "Yellow + Green (Flashes 2x)",
    meaning: "E2 Erase Keycard Accepted",
    explanation: "Lock memory cleared to Mode 1.",
    urgency: "Low",
    nextStep: "Proceed with programming",
  },
];

const LED_NAMES: Record<LedColor, string> = { G: "Green", Y: "Yellow", R: "Red" };

function SignalDiagram({ signal }: { signal: Signal }) {
  return (
    <div className={styles.signal}>
      {signal.groups.map((group, index) => (
        <div className={styles.signalStep} key={`${group.detail}-${index}`}>
          {index > 0 && (
            <span className={styles.signalConnector} aria-label={
              signal.connector === "alternating" ? "alternates with" : signal.connector === "plus" ? "plus" : "then"
            }>
              {signal.connector === "alternating" ? "↔" : signal.connector === "plus" ? "+" : "→"}
            </span>
          )}
          <div className={styles.signalGroup}>
            {group.colors.length > 0 && (
              <div className={styles.ledTokens}>
                {group.colors.map((color, colorIndex) => (
                  <span className={styles.ledToken} key={`${color}-${colorIndex}`}>
                    {colorIndex > 0 && group.colorRelation === "plus" && <span aria-label="plus">+</span>}
                    <span className={`${styles.ledDot} ${styles[`led${color}`]}`} aria-hidden="true" />
                    <span>{LED_NAMES[color]} ({color})</span>
                  </span>
                ))}
              </div>
            )}
            <span className={styles.signalDetail}>{group.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DormakabaEntryCard({ entry }: { entry: DormakabaEntry }) {
  return (
    <article className={styles.entry} aria-labelledby={`dormakaba-${entry.code}`}>
      <div className={styles.entryHeader}>
        <span className={styles.entryCode}>{entry.code}</span>
        <h3 id={`dormakaba-${entry.code}`} className={styles.entryTitle}>{entry.meaning}</h3>
      </div>
      <div className={styles.patternPanel}>
        <SignalDiagram signal={entry.pattern} />
        <p className={styles.patternText}>{entry.patternText}</p>
      </div>
      <p className={styles.entryExplanation}>{entry.explanation}</p>
      <div className={styles.urgencyLine}>
        <span className={`${styles.urgency} ${styles[`urgency${entry.urgency}`]}`}>{entry.urgency}</span>
        {entry.nextStep && <span>{entry.nextStep}</span>}
      </div>
      {entry.note && <p className={styles.sourceNote}>{entry.note}</p>}
    </article>
  );
}

function EnseoGuide() {
  return (
    <>
      <header className={styles.guideHeader}>
        <p className={styles.eyebrow}>Enseo Set-Top Box (STB)</p>
        <h1 id="guide-title">Television Troubleshooting Guide</h1>
        <p>This guide is designed for front desk associates to handle common guest room television issues involving the Enseo set-top box (STB) without the need for the Engineering Department.</p>
        <p>Any team member can contact Enseo support 24/7 at <strong>866-717-3075</strong>.</p>
      </header>

      <section className={styles.guideSection}>
        <h2>Basic Power &amp; Visual Checks</h2>
        <ul>
          <li><strong>LED Status:</strong> Ensure the Enseo box has power by checking for a <strong>solid green LED</strong> light inside the unit.</li>
          <li><strong>Startup Delay:</strong> There is at least a <strong>5-second delay</strong> before the system responds after pushing the power button on the remote. Look for a blinking red LED on the front or underside of the TV to confirm it received the signal from the remote.</li>
          <li><strong>Cable Integrity:</strong> Verify that power cables for both the Enseo STB and the TV are firmly connected. Ensure the HDMI cable is securely plugged into the box and into the TV&apos;s <strong>HDMI 1</strong> port. Confirm that the MPI cable is also plugged into the TV&apos;s MPI port and into the Enseo STB. (Looks like a telephone wire.) Verify the coaxial cable is plugged into the wall and the Enseo STB.</li>
        </ul>
      </section>

      <section className={styles.guideSection}>
        <h2>Quick Reset Steps (The First Response)</h2>
        <p>Most issues can be resolved by a &quot;Power Cycle.&quot; If a guest has any TV issue, try this first:</p>
        <ol>
          <li><strong>Unplug the power cord</strong> from the back of the Enseo box. The round “barrell” type plug.</li>
          <li><strong>Wait 30 seconds</strong> to allow the internal capacitors to discharge.</li>
          <li>Plug the power back in.</li>
          <li><strong>Wait 7 minutes</strong> for the system to reboot. The Enseo logo should appear on the screen during this time. The TV will also automatically turn off. Continue to wait the full 7 minutes. Then try turning the power back on.</li>
        </ol>
      </section>

      <section className={styles.guideSection}>
        <h2>Common Scenarios &amp; Solutions</h2>
        <h3>1. &quot;No Signal&quot; or Black/Grey Screen</h3>
        <ul>
          <li><strong>HDMI Cable:</strong> Sometimes replacing the cable can resolve issues with picture and sound.</li>
          <li><strong>Check Input:</strong> Ensure the TV is on the correct HDMI input (usually <strong>HDMI 1</strong>). Guests often accidentally change this using buttons on the TV frame.</li>
          <li><strong>Loose Cables:</strong> Verify the HDMI cable is securely plugged into both the Enseo box and the TV.</li>
          <li><strong>Grey Screen:</strong> This often means the box is stuck while trying to load the channel tuner. Perform a Power Cycle.</li>
          <li><strong>Resolution Mismatch:</strong> If the screen says &quot;Unsupported Mode,&quot; the box resolution might be set too high. A reboot usually auto-negotiates the correct resolution.</li>
        </ul>

        <h3>2. Remote Control Not Responding</h3>
        <ul>
          <li><strong>Line of Sight:</strong> Ensure the bottom of the TV isn&apos;t blocked by guest items.</li>
          <li><strong>Batteries:</strong> Replace with 2 fresh AA batteries.</li>
          <li><strong>MPI Cable:</strong> Ensure the MPI (Multi-Port Interface) cable is plugged into the back of the TV as well as into the Enseo STP.</li>
          <li><strong>If Problem Persists:</strong> Give the guest a new remote control. Put the non-functional remote in the Engineering Department Work Order Drop Box.</li>
        </ul>

        <h3>3. Frozen Image or Pixelation</h3>
        <ul>
          <li><strong>Network Check:</strong> Pixelation is often caused by a weak signal. If multiple rooms are reporting this, it may be a property-wide server or &quot;headend&quot; issue.</li>
          <li><strong>Cable Swap:</strong> If only one room is affected, the HDMI cable may be damaged.</li>
        </ul>

        <h3>4. Low or No Volume</h3>
        <ul>
          <li><strong>Two Volume Controls:</strong> Both the TV and the Enseo box have volume settings. Ensure the TV&apos;s physical volume is set to around 50%, then use the Enseo remote to adjust the guest&apos;s level.</li>
          <li><strong>Mute:</strong> Check if &quot;Mute&quot; is active on the Enseo interface.</li>
        </ul>

        <h3>5. No Internet</h3>
        <ul>
          <li>Check that the remote antennas are connected to the Enseo STB&apos;s USB ports.</li>
        </ul>
      </section>

      <section className={styles.guideSection}>
        <h2>Phone Support</h2>
        <ul>
          <li>Enseo&apos;s support team is available 24/7 at <strong>1-866-717-3075</strong>.</li>
          <li>Provide them with your name, name of the hotel, position (eg. Front Desk) and room number. They will be more than happy to assist you.</li>
          <li>Sometimes issues with the STB can be resolved if they &apos;remote&apos; into it.</li>
        </ul>
      </section>
      <p className={styles.sourceDate}>Apr’26</p>
    </>
  );
}

function DormakabaGuide() {
  const sections: Array<{ title: string; description: string; entries: DormakabaEntry[] }> = [
    {
      title: "Normal keycard indicators",
      description: "Common front-desk signals, including successful access and power warnings.",
      entries: NORMAL_ENTRIES,
    },
    {
      title: "Special function keycards",
      description: "Read the complete signal, including the follow-on flashes.",
      entries: SPECIAL_ENTRIES,
    },
    {
      title: "Invalid lock mode indicators",
      description: "Resequence, inhibit, electronic lockout, programming, and erase-card responses.",
      entries: INVALID_MODE_ENTRIES,
    },
  ];

  return (
    <>
      <header className={styles.guideHeader}>
        <p className={styles.eyebrow}>DORMAKABA / LED SIGNAL GUIDE</p>
        <h1 id="guide-title">Dormakaba LED Visual Guide</h1>
        <div className={styles.ledLegend} aria-label="LED color labels">
          {(["G", "Y", "R"] as const).map((color) => (
            <span className={styles.ledToken} key={color}>
              <span className={`${styles.ledDot} ${styles[`led${color}`]}`} aria-hidden="true" />
              <strong>{color}</strong> {LED_NAMES[color]}
            </span>
          ))}
        </div>
      </header>

      {sections.map((section, index) => (
        <section className={styles.guideSection} key={section.title}>
          <div className={styles.sectionHeading}>
            <span className={styles.sectionNumber}>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h2>{section.title}</h2>
              <p>{section.description}</p>
            </div>
          </div>
          <div className={styles.entryGrid}>
            {section.entries.map((entry) => <DormakabaEntryCard key={entry.code} entry={entry} />)}
          </div>
        </section>
      ))}

      <aside className={styles.guideNotes}>
        <h2>Reading the signals</h2>
        <p>× = flash count. Arrows = stated order. Letters identify colors even in grayscale.</p>
        <p><strong>Sequence key:</strong> In special-function patterns, the first group precedes the all-three ×4 group. Only MODE 0 explicitly says simultaneous.</p>
        <p><strong>Reused signals:</strong> I04 and I06 have the same pattern and different meanings. Yellow ×12 is also used in N02 and I05. Match the card/function context as well as the lights. “+” is retained from the source; it does not establish timing.</p>
        <p><strong>Source notes:</strong> N06 does not name another LED or specify a count. S01 does not state the order within its first group. S04 does not separately define the Yellow count or timing.</p>
        <p>All counts and durations shown are those stated in the source. Diagrams are schematic, not timed animations.</p>
        <p>Source: Dormakaba LED Light Indicator Table.pdf · source page 1. 22 entries · 3 sections.</p>
      </aside>
    </>
  );
}

function GuestRoomGuide() {
  return (
    <>
      <section className={styles.guideSection}>
        <p className={styles.eyebrow} lang="en">English</p>
        <h1 id="guide-title">Guest Room Troubleshooting Guide</h1>
        <p>Use this guide to assist guests in their current rooms with common resolutions to issues before initiating a room move and submitting a work order.</p>

        <h2>1. HVAC &amp; Climate Control</h2>
        <h3>Unit Not Heating/Cooling or fan isn’t working</h3>
        <ul>
          <li>Find the breaker panel (typically found behind the entry or bedroom doors). Open and find the breaker labeled PTAC. Turn off the breaker for 1 minute. Turn on. The thermostat will turn on automatically. Push the power button on the thermostat to turn off the thermostat and PTAC unit, then press the power button to turn them back on. If any other button is pressed other than the power, restart this step.</li>
          <li>Check the desired set temperature and wait a couple minutes then use the infrared thermometer to check the vent temperature: it should be <strong>below 65°F</strong> in cooling mode or <strong>above 80°F</strong> in heating mode.</li>
          <li>If this did not resolve the issue, submit a work order.</li>
        </ul>

        <h2>2. Hot &amp; Cold Water Issues</h2>
        <ul>
          <li>Have the guest give you an example of how they are turning the shower or faucet on.</li>
          <li>Test water temperature and flow: turn the handle completely in one direction for <strong>1–2 minutes</strong>, then rotate it the other way just before, without turning off the water, to verify both hot and cold temperatures with good pressure.</li>
        </ul>

        <h2>3. Kitchenette Appliances</h2>
        <h3>Garbage Disposal</h3>
        <ul>
          <li>If it won&apos;t turn on using the switch, press the red or black reset button on the bottom of the unit under the sink.</li>
          <li>If this did not resolve the issue, submit a work order.</li>
          <li>If the unit hums, has water leaking out of the bottom - turn off power and faucet and submit a work order.</li>
        </ul>
        <h3>Loud Refrigerator</h3>
        <ul>
          <li>Ensure the fridge is level and not pushed directly against the wall or cabinet, which can cause vibration noise.</li>
          <li>Open the freezer, if the fan is making loud noise, or the refrigerator is not level, submit a work order.</li>
        </ul>
        <h3>Microwave</h3>
        <ul>
          <li>If any errors show on the display, locate the breaker inside the panel, turn off for 30 seconds then reenergize.</li>
          <li>If this did not resolve the issue, submit a work order.</li>
        </ul>

        <h2>4. Electrical, Outlets &amp; Lights</h2>
        <h3>If lights do not come on</h3>
        <ul>
          <li>Check the orange master switch to see if it is in the on position.</li>
          <li>Locate any tripped breaker in the panel and reset it.</li>
          <li>If a problem persists, submit a work order.</li>
        </ul>
        <h3>Dead Outlets</h3>
        <ul>
          <li>If outlets in the bathroom or kitchen aren&apos;t working, check for a tripped GFI button (the small button between the sockets) and press &quot;Reset.&quot;</li>
          <li>If not in the bathroom or kitchen, check the breaker panel for tripped breakers.</li>
          <li>If a problem persists, submit a work order.</li>
        </ul>

        <h2>5. TV</h2>
        <h3>If TV is not powering on</h3>
        <ul>
          <li>Please be patient after pushing power on the remote - there is at least a <strong>5 second delay</strong> between pushing the power button on the remote and the TV turning on. You might see the red LED blink on the front or under the TV.</li>
          <li>Check the power cables for the Enseo box and TV to be sure they are connected properly.</li>
          <li>Making sure each end of the HDMI cable is plugged into the cable box and input HDMI 1.</li>
          <li>If the TV is on, but the box seems unresponsive, displaying any errors, and everything appears to be plugged in, unplug the power cable from the Enseo box, wait <strong>30 seconds</strong>, reenergize the box. Wait for the Enseo box to restart.</li>
          <li>If a problem persists, submit a work order.</li>
        </ul>
      </section>

      <section className={styles.guideSection} lang="es" aria-labelledby="guest-room-spanish">
        <p className={styles.eyebrow}>Español</p>
        <h1 id="guest-room-spanish">Guía de Resolución de Problemas para Habitaciones de Huéspedes</h1>
        <p>Use esta guía para asistir a los huéspedes en sus habitaciones actuales con soluciones comunes a problemas antes de iniciar un cambio de habitación o enviar una orden de trabajo.</p>

        <h2>1. HVAC y Control de Clima</h2>
        <h3>La unidad no calienta/enfría o el ventilador no funciona</h3>
        <ul>
          <li>Busque el panel de interruptores (generalmente detrás de la puerta de entrada). Ábralo y busque el interruptor etiquetado como PTAC. Apague el interruptor durante <strong>1 minuto</strong>. Enciéndalo. El termostato se encenderá automáticamente. Presione el botón de encendido en el termostato para apagar la unidad PTAC, luego presione el botón de encendido para volver a encenderla. Si se presiona cualquier otro botón que no sea el de encendido, reinicie este paso.</li>
          <li>Espere un par de minutos y luego use el termómetro infrarrojo para verificar la temperatura de la rejilla: debe estar <strong>por debajo de 65°F</strong> en modo de enfriamiento o <strong>por encima de 80°F</strong> en modo de calefacción.</li>
          <li>Si esto no resolvió el problema, envíe una orden de trabajo.</li>
        </ul>

        <h2>2. Problemas de Agua Caliente y Fría</h2>
        <ul>
          <li>Pida al huésped que le muestre cómo está abriendo la ducha o el grifo.</li>
          <li>Pruebe la temperatura y el flujo del agua: gire la manija completamente en una dirección durante <strong>1 a 2 minutos</strong>, luego gírela completamente hacia el otro lado justo antes de cerrar el agua para verificar tanto la temperatura caliente como la fría y que haya buena presión.</li>
        </ul>

        <h2>3. Electrodomésticos de la Cocina</h2>
        <h3>Triturador de Basura</h3>
        <ul>
          <li>Si no se enciende, presione el botón de reinicio rojo o negro en la parte inferior de la unidad, debajo del fregadero.</li>
          <li>Si esto no resolvió el problema, envíe una orden de trabajo.</li>
          <li>Si la unidad emite un zumbido o tiene fugas de agua por la parte inferior, apague la alimentación y el grifo, y envíe una orden de trabajo.</li>
        </ul>
        <h3>Refrigerador Ruidoso</h3>
        <ul>
          <li>Asegúrese de que el refrigerador esté nivelado y no esté empujado directamente contra la pared o el gabinete, lo que puede causar ruido por vibración.</li>
          <li>Abra el congelador; si el ventilador hace un ruido fuerte o el refrigerador no está nivelado, envíe una orden de trabajo.</li>
        </ul>
        <h3>Microondas</h3>
        <ul>
          <li>Si aparece algún error en la pantalla, localice el interruptor automático (breaker) dentro del panel.</li>
          <li>Si esto no resolvió el problema, envíe una orden de trabajo.</li>
        </ul>

        <h2>4. Electricidad, Enchufes y Luces</h2>
        <h3>Si las luces no se encienden</h3>
        <ul>
          <li>Verifique el interruptor maestro naranja para ver si está en la posición de encendido (&quot;on&quot;).</li>
          <li>Localice cualquier interruptor disparado en el panel y restablezcalo.</li>
          <li>Si el problema persiste, envíe una orden de trabajo.</li>
        </ul>
        <h3>Enchufes sin Corriente</h3>
        <ul>
          <li>Si los enchufes del baño o la cocina no funcionan, verifique si se disparó el botón GFI (el botón pequeño entre las tomas) y presione &quot;Reset&quot;.</li>
          <li>Si no es en el baño o la cocina, revise el panel de interruptores en busca de interruptores disparados. Tendrán una luz naranja. Apague ese interruptor y vuelva a encenderlo.</li>
          <li>Si el problema persiste, envíe una orden de trabajo.</li>
        </ul>

        <h2>5. TV</h2>
        <h3>Si la televisión no enciende</h3>
        <ul>
          <li>Por favor, sea paciente después de presionar el botón de encendido en el control remoto: hay un retraso de al menos <strong>5 segundos</strong>. Es posible que vea parpadear el LED rojo.</li>
          <li>Verifique que los cables de alimentación de la caja Enseo y de la TV estén conectados correctamente.</li>
          <li>Asegúrese de que cada extremo del cable HDMI esté conectado a la caja de cable y a la entrada HDMI 1.</li>
          <li>Si la caja no responde, muestra errores y todo parece estar conectado, desenchufe el cable de alimentación de la caja Enseo, espere <strong>30 segundos</strong> y vuelva a conectarla.</li>
          <li>Si el problema persiste, envíe una orden de trabajo.</li>
        </ul>
      </section>
    </>
  );
}

export function GuideContent({ guide }: { guide: GuideId }) {
  if (guide === "enseo") return <EnseoGuide />;
  if (guide === "dormakaba") return <DormakabaGuide />;
  return <GuestRoomGuide />;
}

/** The PDFs are print exports of GuideContent below; no guide content is rewritten. */
export default function TroubleshootingGuideDropdown() {
  return (
    <select
      aria-label="Front Desk Quick Guides"
      defaultValue=""
      onChange={(event) => {
        const option = GUIDE_OPTIONS.find((guide) => guide.id === event.currentTarget.value);
        if (option) window.open(option.href, "_blank", "noopener,noreferrer");
        event.currentTarget.value = "";
      }}
      className="min-h-9 max-w-full rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
    >
      <option value="" disabled>Front Desk Quick Guides</option>
      {GUIDE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
    </select>
  );
}
