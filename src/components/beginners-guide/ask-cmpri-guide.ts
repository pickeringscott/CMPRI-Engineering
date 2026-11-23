import type { GuideAction } from "./GuideWalkthrough";

// Approved sample directions and screen captures.
export const ASK_CMPRI_GUIDE: { key: string; title: string; actions: GuideAction[] } = {
  key: "ask-cmpri",
  title: "Ask CMPRI",
  actions: [
    {
      title: "Type in the desktop search pill",
      context: "Dashboard · Ask CMPRI",
      text: "Start in the highlighted desktop search pill.",
      directions: [
        [
          "Search field",
          "Click to the right of the Gemini star. Type a question like the one in the preview."
        ],
        [
          "Enter or Gemini star",
          "Press Enter or click the star to run the question you typed."
        ],
        [
          "Gemini star with an empty field",
          "To start inside the Ask CMPRI window, leave the dashboard field empty and click the star."
        ],
        [
          "Weather modal",
          "Ask CMPRI covers current weather, forecasts, alerts, history, radar, maps, astronomy and Airport information from the existing Weather modal. Access follows your signed-in role. Answers link back to Weather and retain source times and any unavailable or stale information."
        ]
      ],
      result: "Ask CMPRI opens. With a typed question, the answer appears above the search pill. With an empty field, you can start a search inside Ask CMPRI.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-launch-text.webp",
        width: 370,
        height: 73,
        alt: "The updated desktop search pill with a typed question and its Gemini star"
      },
      target: [
        96,
        28,
        250,
        27
      ],
      mobile: {
        title: "Open Ask CMPRI on mobile",
        text: "Start with the highlighted Ask CMPRI button on the dashboard.",
        directions: [
          [
            "Ask CMPRI button",
            "Tap the button with the Gemini star."
          ],
          [
            "Search field",
            "Tap the field at the bottom of Search to type your question."
          ]
        ],
        result: "Ask CMPRI opens with the search pill at the bottom of the Search tab.",
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/launch-mobile.webp",
          width: 390,
          height: 98,
          alt: "The mobile dashboard header with the Ask CMPRI launcher"
        },
        target: [
          143,
          28,
          103,
          31
        ],
        fitToWidth: true
      }
    },
    {
      title: "Start a voice call",
      context: "Desktop launcher · Microphone",
      text: "Start a voice call from the highlighted microphone.",
      directions: [
        [
          "Microphone",
          "Clear the desktop field if it contains text, then click the microphone on the right. Allow access if asked and speak your question."
        ],
        [
          "Gemini star",
          "While the call is active, click the star to open Search and read the transcript."
        ]
      ],
      result: "The call starts audio-only and the red Stop button replaces the mic. Opening Search shows the transcript and keeps the same call connected.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-launch-mic.webp",
        width: 254,
        height: 73,
        alt: "The empty desktop search pill with the microphone highlighted"
      },
      target: [
        205,
        29,
        22,
        25
      ],
      mobile: {
        context: "Ask CMPRI · Search",
        directions: [
          [
            "Microphone",
            "In Search, tap the microphone next to the Gemini star. Allow microphone access if asked."
          ],
          [
            "Voice",
            "Ask your question aloud. Your spoken question and answer appear above the search pill."
          ]
        ],
        result: "Stop appears in the search pill, with a running summary and draft note above it.",
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-voice-mic-mobile.webp",
          width: 374,
          height: 75,
          alt: "The mobile Ask CMPRI search pill showing the microphone to the left of the Gemini star"
        },
        target: [
          6,
          19,
          45,
          45
        ],
        fitToWidth: true
      }
    },
    {
      title: "End a voice call",
      context: "Desktop launcher · Call active",
      text: "Use any of these options while the call is active.",
      directions: [
        [
          "Red Stop button",
          "Click the button with the black square."
        ],
        [
          "Esc key",
          "Press Esc to end the call from the keyboard."
        ],
        [
          "Voice",
          "Say “goodbye.”"
        ]
      ],
      result: "Stop disappears and the microphone returns. Open Ask CMPRI to review the call transcript.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-launch-stop.webp",
        width: 254,
        height: 73,
        alt: "The active desktop voice call showing the red Stop button with a black square"
      },
      target: [
        205,
        30,
        22,
        23
      ],
      mobile: {
        context: "Ask CMPRI · Call active",
        directions: [
          [
            "Stop button",
            "Tap Stop in the search pill."
          ],
          [
            "Voice",
            "Say “goodbye” while Ask CMPRI is listening."
          ]
        ],
        result: "The microphone returns and your conversation stays in Search. If the call created a note, tap View draft to review it.",
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-voice-stop-mobile.webp",
          width: 374,
          height: 167,
          alt: "An active mobile voice call with the running summary and draft note above the Stop button"
        },
        target: [
          221,
          111,
          61,
          45
        ],
        fitToWidth: true
      }
    },
    {
      title: "Search or attach a file",
      context: "Ask CMPRI · Search",
      text: "Ask a question or include a file from the Search tab.",
      directions: [
        [
          "Search field",
          "Click next to the Gemini star and type your question."
        ],
        [
          "Paperclip",
          "To include a file, click the paperclip and choose one, or drop a file into Search."
        ],
        [
          "Magnifying glass",
          "Click the circular Search button to submit."
        ]
      ],
      result: "Attachments appear with your draft. After you submit, the answer appears above the pill and the question stays editable.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-search-tools.webp",
        width: 620,
        height: 89,
        alt: "The full desktop search pill with the text field, paperclip, and circular magnifying glass"
      },
      target: [
        532,
        35,
        82,
        43
      ],
      fitToWidth: true,
      mobile: {
        directions: [
          [
            "Search field",
            "Tap next to the Gemini star and type your question."
          ],
          [
            "Paperclip",
            "Tap it to open the choices shown. Tap Take a Picture on the left for the camera, or Attach File on the right for the device picker."
          ],
          [
            "Magnifying glass",
            "Tap the circular Search button to submit."
          ]
        ],
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-search-tools-mobile.webp",
          width: 374,
          height: 131,
          alt: "The mobile Gemini search bar with the paperclip, circular magnifying glass, Take a Picture on the left, and Attach File on the right"
        },
        target: [
          135,
          10,
          233,
          110
        ],
        fitToWidth: true
      }
    },
    {
      title: "Use the Ask CMPRI tabs",
      context: "Ask CMPRI · Search, Notepad, History, and Files",
      text: "Use the highlighted tabs to move between four parts of Ask CMPRI.",
      directions: [
        [
          "Select Search",
          "Ask a question, read the results above the pill, use voice, or add an attachment."
        ],
        [
          "Select Notepad",
          "Choose a titled note from the sidebar or use + inside Search Notes to create one. New notes default to Just me; use Shared with… for roles, departments or individuals. Shared lists keep replies and completion names with each item. The paperclip opens GIF and file choices."
        ],
        [
          "Select History",
          "Review recent searches and transcripts."
        ],
        [
          "Select Files",
          "Open and manage files saved on your device."
        ]
      ],
      result: "The selected tab highlights and its content replaces the previous view in the same Ask CMPRI window.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-overview-desktop.webp",
        width: 900,
        height: 501,
        alt: "The desktop Ask CMPRI Search, Staff Notes, History, and Files tabs"
      },
      target: [
        619,
        0,
        250,
        31
      ],
      mobile: {
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-overview-mobile.webp",
          width: 374,
          height: 523,
          alt: "The mobile Ask CMPRI Search, Staff Notes, History, and Files tabs"
        },
        target: [
          93,
          0,
          250,
          31
        ],
        fitToWidth: true
      }
    },
    {
      title: "Reopen a recent search",
      context: "Ask CMPRI · History",
      text: "Return to a question you’ve already asked.",
      directions: [
        [
          "History tab",
          "Select History at the top of Ask CMPRI."
        ],
        [
          "Saved question",
          "Select “Where is the salt stored?” to expand the answer shown in the example."
        ],
        [
          "Resume search",
          "Select the highlighted button below that answer."
        ]
      ],
      result: "Search reopens the saved conversation above the pill. You can edit the question or ask a follow-up.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-history-resume.webp",
        width: 900,
        height: 501,
        alt: "Desktop History with a recent search expanded and Resume search highlighted"
      },
      target: [
        19,
        305,
        113,
        36
      ],
      mobile: {
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-history-resume-mobile.webp",
          width: 374,
          height: 523,
          alt: "Mobile History with a recent search expanded and Resume search highlighted"
        },
        target: [
          9,
          337,
          113,
          36
        ],
        fitToWidth: true
      }
    },
    {
      title: "Ask about Room 134",
      context: "Ask CMPRI · A room conversation",
      text: "Ask a question in your own words. Try the highlighted example.",
      directions: [
        [
          "Enter a question",
          "Type “Does 134 have a sofa bed?” in Search."
        ],
        [
          "Submit",
          "Press Enter or select the magnifying glass."
        ],
        [
          "Read the result",
          "Look above the search pill for the room’s recorded features."
        ]
      ],
      result: "Ask CMPRI identifies Room 134 as a King Studio with a queen-size sofa bed.",
      hint: "The example uses Chief Engineer access. Your results depend on your demo role.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-room-134.webp",
        width: 900,
        height: 749,
        alt: "Ask CMPRI answers “Does 134 have a sofa bed?” with Room 134’s King Studio and queen-size sofa bed details"
      },
      target: [
        19,
        78,
        862,
        163
      ],
      mobile: {
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-room-134-mobile.webp",
          width: 374,
          height: 785,
          alt: "Ask CMPRI answers “Does 134 have a sofa bed?” with Room 134’s King Studio and queen-size sofa bed details"
        },
        target: [
          9,
          74,
          356,
          163
        ],
        fitToWidth: true
      }
    },
    {
      title: "Follow up about maintenance",
      context: "Ask CMPRI · Continue the same conversation",
      text: "Follow up on the room you just asked about.",
      directions: [
        [
          "Ask a follow-up",
          "Type “Any maintenance issues there?” in the same conversation."
        ],
        [
          "Read the work orders",
          "Review what was reported and check each ticket’s status and repair note."
        ],
        [
          "Open a ticket",
          "Select a linked work-order number to see the record."
        ]
      ],
      result: "Ask CMPRI understands “there” as Room 134. The results include active issues, completed work, and a closed sofa-bed repair.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-room-maintenance.webp",
        width: 900,
        height: 749,
        alt: "The same Ask CMPRI conversation follows up on Room 134 with maintenance issues, statuses, and repair notes"
      },
      target: [
        19,
        78,
        862,
        210
      ],
      mobile: {
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-room-maintenance-mobile.webp",
          width: 374,
          height: 785,
          alt: "The same Ask CMPRI conversation follows up on Room 134 with maintenance issues, statuses, and repair notes"
        },
        target: [
          9,
          74,
          356,
          210
        ],
        fitToWidth: true
      }
    },
    {
      title: "Put the results in a table",
      context: "Ask CMPRI · Choose an answer format",
      text: "Ask for the response format that helps you review the information.",
      directions: [
        [
          "Request a table",
          "Type “Put that in a table” and submit."
        ],
        [
          "Review the rows",
          "Compare reported issues, statuses, and repairs across the same room’s work orders."
        ]
      ],
      result: "Ask CMPRI keeps the maintenance findings and shows them in a table with linked tickets.",
      hint: "Choose a format in your own words. A table works well when you need to compare fields.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-room-table.webp",
        width: 900,
        height: 749,
        alt: "The same Room 134 maintenance results in a table with linked ticket numbers"
      },
      target: [
        19,
        524,
        862,
        164
      ],
      mobile: {
        directions: [
          [
            "Request a table",
            "Type “Put that in a table” and submit."
          ],
          [
            "Review the rows",
            "Swipe across the table to see work-order numbers, statuses, and repairs."
          ]
        ],
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-room-table-mobile.webp",
          width: 374,
          height: 785,
          alt: "The same Room 134 maintenance results in a table with linked ticket numbers"
        },
        target: [
          9,
          464,
          365,
          246
        ],
        fitToWidth: true
      }
    },
    {
      title: "Add a column and sort the table",
      context: "Ask CMPRI · Refine the answer",
      text: "Keep the current conversation and ask for both changes together.",
      directions: [
        [
          "Request the update",
          "Type “Add a priority column and sort by priority” and submit."
        ],
        [
          "Review Priority",
          "Read from higher priority to lower priority. The High-priority bathroom faucet issue appears first."
        ]
      ],
      result: "The table gains a Priority column and keeps the same four work orders, sorted with the highest priority first.",
      hint: "You can continue the conversation with another question or request a different answer format.",
      screenshot: {
        src: "/beginners-guide/captures/ask-cmpri/ask-room-priority.webp",
        width: 900,
        height: 749,
        alt: "The Room 134 table with a highlighted Priority column and the High-priority faucet issue first"
      },
      target: [
        801,
        523,
        80,
        165
      ],
      mobile: {
        directions: [
          [
            "Request the update",
            "Type “Add a priority column and sort by priority” and submit."
          ],
          [
            "Review Priority",
            "Swipe across the table to the new column. The High-priority bathroom faucet issue appears first."
          ]
        ],
        screenshot: {
          src: "/beginners-guide/captures/ask-cmpri/ask-room-priority-mobile.webp",
          width: 374,
          height: 785,
          alt: "The Room 134 table with a highlighted Priority column and the High-priority faucet issue first"
        },
        target: [
          299,
          442,
          67,
          246
        ],
        fitToWidth: true
      }
    }
  ]
};
