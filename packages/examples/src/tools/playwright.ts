/**
 * playwright — 24 tools, GENERATED. Do not edit by hand.
 *
 * Source: `packages/mcp/test/real-schemas/playwright.json` (a verbatim
 * `tools/list` payload from the real server), run through
 * `mcpToolsToDefinitions` with namespace `"browser"`.
 * Regenerate with `pnpm --filter @codeflow/examples embed`.
 */

import type { ToolDefinition } from "@codeflow/core";

export const PLAYWRIGHT_TOOLS: ToolDefinition[] = [
    {
      "name": "browser.close",
      "label": "Close browser",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Close the page"
    },
    {
      "name": "browser.resize",
      "label": "Resize browser window",
      "inputSchema": {
        "type": "object",
        "properties": {
          "width": {
            "type": "number",
            "description": "Width of the browser window"
          },
          "height": {
            "type": "number",
            "description": "Height of the browser window"
          }
        },
        "required": [
          "width",
          "height"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Resize the browser window",
      "editableFields": [
        "width",
        "height"
      ]
    },
    {
      "name": "browser.consoleMessages",
      "label": "Get console messages",
      "inputSchema": {
        "type": "object",
        "properties": {
          "level": {
            "default": "info",
            "description": "Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to \"info\".",
            "type": "string",
            "enum": [
              "error",
              "warning",
              "info",
              "debug"
            ]
          },
          "all": {
            "description": "Return all console messages since the beginning of the session, not just since the last navigation. Defaults to false.",
            "type": "boolean"
          },
          "filename": {
            "description": "Filename to save the console messages to. If not provided, messages are returned as text.",
            "type": "string"
          }
        },
        "required": [
          "level"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Returns all console messages",
      "editableFields": [
        "level",
        "all",
        "filename"
      ]
    },
    {
      "name": "browser.handleDialog",
      "label": "Handle a dialog",
      "inputSchema": {
        "type": "object",
        "properties": {
          "accept": {
            "type": "boolean",
            "description": "Whether to accept the dialog."
          },
          "promptText": {
            "description": "The text of the prompt in case of a prompt dialog.",
            "type": "string"
          }
        },
        "required": [
          "accept"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Handle a dialog",
      "editableFields": [
        "accept",
        "promptText"
      ]
    },
    {
      "name": "browser.evaluate",
      "label": "Evaluate JavaScript",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "description": "Exact target element reference from the page snapshot, or a unique element selector",
            "type": "string"
          },
          "function": {
            "type": "string",
            "description": "() => { /* code */ } or (element) => { /* code */ } when element is provided"
          },
          "filename": {
            "description": "Filename to save the result to. If not provided, result is returned as text.",
            "type": "string"
          }
        },
        "required": [
          "function"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Evaluate JavaScript expression on page or element",
      "editableFields": [
        "element",
        "target",
        "function",
        "filename"
      ]
    },
    {
      "name": "browser.fileUpload",
      "label": "Upload files",
      "inputSchema": {
        "type": "object",
        "properties": {
          "paths": {
            "description": "The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled.",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Upload one or multiple files",
      "editableFields": [
        "paths"
      ]
    },
    {
      "name": "browser.drop",
      "label": "Drop files or data onto an element",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          },
          "paths": {
            "description": "Absolute paths to files to drop onto the element.",
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "data": {
            "description": "Data to drop, as a map of MIME type to string value (e.g. {\"text/plain\": \"hello\", \"text/uri-list\": \"https://example.com\"}).",
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {
              "type": "string"
            }
          }
        },
        "required": [
          "target"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Drop files or MIME-typed data onto an element, as if dragged from outside the page. At least one of \"paths\" or \"data\" must be provided.",
      "editableFields": [
        "element",
        "target",
        "paths",
        "data"
      ]
    },
    {
      "name": "browser.find",
      "label": "Find in page snapshot",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "description": "Plain text to search for in the page snapshot (case-insensitive substring match). Provide either text or regex, not both.",
            "type": "string"
          },
          "regex": {
            "description": "Regular expression to search for in the page snapshot. Matching is case-sensitive by default; wrap the pattern in slashes to add flags, e.g. \"/error/i\" for case-insensitive. Provide either text or regex, not both.",
            "type": "string"
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot nodes with a few lines of surrounding context (like search snippets), each shown under its path from the root of the tree, which is cheaper than capturing the whole snapshot when you only need to locate an element and its ref.",
      "editableFields": [
        "text",
        "regex"
      ]
    },
    {
      "name": "browser.fillForm",
      "label": "Fill form",
      "inputSchema": {
        "type": "object",
        "properties": {
          "fields": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "element": {
                  "description": "Human-readable element description used to obtain permission to interact with the element",
                  "type": "string"
                },
                "target": {
                  "type": "string",
                  "description": "Exact target element reference from the page snapshot, or a unique element selector"
                },
                "name": {
                  "type": "string",
                  "description": "Human-readable field name"
                },
                "type": {
                  "type": "string",
                  "enum": [
                    "textbox",
                    "checkbox",
                    "radio",
                    "combobox",
                    "slider"
                  ],
                  "description": "Type of the field"
                },
                "value": {
                  "type": "string",
                  "description": "Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option."
                }
              },
              "required": [
                "target",
                "name",
                "type",
                "value"
              ],
              "additionalProperties": false
            },
            "description": "Fields to fill in"
          }
        },
        "required": [
          "fields"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Fill multiple form fields",
      "editableFields": [
        "fields"
      ]
    },
    {
      "name": "browser.pressKey",
      "label": "Press a key",
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "description": "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"
          }
        },
        "required": [
          "key"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Press a key on the keyboard",
      "editableFields": [
        "key"
      ]
    },
    {
      "name": "browser.type",
      "label": "Type text",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          },
          "text": {
            "type": "string",
            "description": "Text to type into the element"
          },
          "submit": {
            "description": "Whether to submit entered text (press Enter after)",
            "type": "boolean"
          },
          "slowly": {
            "description": "Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.",
            "type": "boolean"
          }
        },
        "required": [
          "target",
          "text"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Type text into editable element",
      "editableFields": [
        "element",
        "target",
        "text",
        "submit",
        "slowly"
      ]
    },
    {
      "name": "browser.navigate",
      "label": "Navigate to a URL",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL to navigate to"
          }
        },
        "required": [
          "url"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Navigate to a URL",
      "editableFields": [
        "url"
      ]
    },
    {
      "name": "browser.navigateBack",
      "label": "Go back",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Go back to the previous page in the history"
    },
    {
      "name": "browser.networkRequests",
      "label": "List network requests",
      "inputSchema": {
        "type": "object",
        "properties": {
          "static": {
            "default": false,
            "description": "Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false.",
            "type": "boolean"
          },
          "filter": {
            "description": "Only return requests whose URL matches this regexp (e.g. \"/api/.*user\").",
            "type": "string"
          },
          "filename": {
            "description": "Filename to save the network requests to. If not provided, requests are returned as text.",
            "type": "string"
          }
        },
        "required": [
          "static"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Returns a numbered list of network requests since loading the page. Use browser_network_request with the number to get full details.",
      "editableFields": [
        "static",
        "filter",
        "filename"
      ]
    },
    {
      "name": "browser.networkRequest",
      "label": "Show network request details",
      "inputSchema": {
        "type": "object",
        "properties": {
          "index": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991,
            "description": "1-based index of the request, as printed by browser_network_requests."
          },
          "part": {
            "description": "Return only this part of the request. Omit to return full details.",
            "type": "string",
            "enum": [
              "request-headers",
              "request-body",
              "response-headers",
              "response-body"
            ]
          },
          "filename": {
            "description": "Filename to save the result to. If not provided, output is returned as text.",
            "type": "string"
          }
        },
        "required": [
          "index"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Returns full details (headers and body) of a single network request, or a single part if `part` is set. Use the number from browser_network_requests.",
      "editableFields": [
        "index",
        "part",
        "filename"
      ]
    },
    {
      "name": "browser.runCodeUnsafe",
      "label": "Run Playwright code (unsafe)",
      "inputSchema": {
        "type": "object",
        "properties": {
          "code": {
            "description": "A JavaScript function containing Playwright code to execute. It will be invoked with a single argument, page, which you can use for any page interaction. For example: `async (page) => { await page.getByRole('button', { name: 'Submit' }).click(); return await page.title(); }`",
            "type": "string"
          },
          "filename": {
            "description": "Load code from the specified file. If both code and filename are provided, code will be ignored.",
            "type": "string"
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent.",
      "editableFields": [
        "code",
        "filename"
      ]
    },
    {
      "name": "browser.takeScreenshot",
      "label": "Take a screenshot",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "description": "Exact target element reference from the page snapshot, or a unique element selector",
            "type": "string"
          },
          "type": {
            "description": "Image format for the screenshot. If unset, inferred from the filename extension, otherwise png.",
            "type": "string",
            "enum": [
              "png",
              "jpeg",
              "webp"
            ]
          },
          "filename": {
            "description": "File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg|webp}` if not specified. Prefer relative file names to stay within the output directory.",
            "type": "string"
          },
          "fullPage": {
            "description": "When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.",
            "type": "boolean"
          },
          "scale": {
            "default": "css",
            "description": "Image resolution scale. \"css\" produces a screenshot sized in CSS pixels (smaller, consistent across devices). \"device\" produces a high-resolution screenshot using device pixels (larger, accounts for the device pixel ratio). Default is css.",
            "type": "string",
            "enum": [
              "css",
              "device"
            ]
          }
        },
        "required": [
          "scale"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.",
      "editableFields": [
        "element",
        "target",
        "type",
        "filename",
        "fullPage",
        "scale"
      ]
    },
    {
      "name": "browser.snapshot",
      "label": "Page snapshot",
      "inputSchema": {
        "type": "object",
        "properties": {
          "target": {
            "description": "Exact target element reference from the page snapshot, or a unique element selector",
            "type": "string"
          },
          "filename": {
            "description": "Save snapshot to markdown file instead of returning it in the response.",
            "type": "string"
          },
          "depth": {
            "description": "Limit the depth of the snapshot tree",
            "type": "number"
          },
          "boxes": {
            "description": "Include each element's bounding box as [box=x,y,width,height] in the snapshot. Coordinates are viewport-relative, in CSS pixels (Element.getBoundingClientRect)",
            "type": "boolean"
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Capture accessibility snapshot of the current page, this is better than screenshot",
      "editableFields": [
        "target",
        "filename",
        "depth",
        "boxes"
      ]
    },
    {
      "name": "browser.click",
      "label": "Click",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          },
          "doubleClick": {
            "description": "Whether to perform a double click instead of a single click",
            "type": "boolean"
          },
          "button": {
            "description": "Button to click, defaults to left",
            "type": "string",
            "enum": [
              "left",
              "right",
              "middle"
            ]
          },
          "modifiers": {
            "description": "Modifier keys to press",
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "Alt",
                "Control",
                "ControlOrMeta",
                "Meta",
                "Shift"
              ]
            }
          }
        },
        "required": [
          "target"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Perform click on a web page",
      "editableFields": [
        "element",
        "target",
        "doubleClick",
        "button",
        "modifiers"
      ]
    },
    {
      "name": "browser.drag",
      "label": "Drag mouse",
      "inputSchema": {
        "type": "object",
        "properties": {
          "startElement": {
            "description": "Human-readable source element description used to obtain the permission to interact with the element",
            "type": "string"
          },
          "startTarget": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          },
          "endElement": {
            "description": "Human-readable target element description used to obtain the permission to interact with the element",
            "type": "string"
          },
          "endTarget": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          }
        },
        "required": [
          "startTarget",
          "endTarget"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Perform drag and drop between two elements",
      "editableFields": [
        "startElement",
        "startTarget",
        "endElement",
        "endTarget"
      ]
    },
    {
      "name": "browser.hover",
      "label": "Hover mouse",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          }
        },
        "required": [
          "target"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Hover over element on page",
      "editableFields": [
        "element",
        "target"
      ]
    },
    {
      "name": "browser.selectOption",
      "label": "Select option",
      "inputSchema": {
        "type": "object",
        "properties": {
          "element": {
            "description": "Human-readable element description used to obtain permission to interact with the element",
            "type": "string"
          },
          "target": {
            "type": "string",
            "description": "Exact target element reference from the page snapshot, or a unique element selector"
          },
          "values": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Array of values to select in the dropdown. This can be a single value or multiple values."
          }
        },
        "required": [
          "target",
          "values"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Select an option in a dropdown",
      "editableFields": [
        "element",
        "target",
        "values"
      ]
    },
    {
      "name": "browser.tabs",
      "label": "Manage tabs",
      "inputSchema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "list",
              "new",
              "close",
              "select"
            ],
            "description": "Operation to perform"
          },
          "index": {
            "description": "Tab index, used for close/select. If omitted for close, current tab is closed.",
            "type": "number"
          },
          "url": {
            "description": "URL to navigate to in the new tab, used for new.",
            "type": "string"
          }
        },
        "required": [
          "action"
        ],
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "List, create, close, or select a browser tab.",
      "editableFields": [
        "action",
        "index",
        "url"
      ]
    },
    {
      "name": "browser.waitFor",
      "label": "Wait for",
      "inputSchema": {
        "type": "object",
        "properties": {
          "time": {
            "description": "The time to wait in seconds",
            "type": "number"
          },
          "text": {
            "description": "The text to wait for",
            "type": "string"
          },
          "textGone": {
            "description": "The text to wait for to disappear",
            "type": "string"
          }
        },
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false
      },
      "description": "Wait for text to appear or disappear or a specified time to pass",
      "editableFields": [
        "time",
        "text",
        "textGone"
      ]
    }
  ];
