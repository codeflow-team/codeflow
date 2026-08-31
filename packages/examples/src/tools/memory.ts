/**
 * memory — 9 tools, GENERATED. Do not edit by hand.
 *
 * Source: `packages/mcp/test/real-schemas/memory.json` (a verbatim
 * `tools/list` payload from the real server), run through
 * `mcpToolsToDefinitions` with namespace `"memory"`.
 * Regenerate with `pnpm --filter @codeflow-team/examples embed`.
 */

import type { ToolDefinition } from "@codeflow-team/core";

export const MEMORY_TOOLS: ToolDefinition[] = [
    {
      "name": "memory.createEntities",
      "label": "Create Entities",
      "inputSchema": {
        "type": "object",
        "properties": {
          "entities": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "The name of the entity"
                },
                "entityType": {
                  "type": "string",
                  "description": "The type of the entity"
                },
                "observations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observation contents associated with the entity"
                }
              },
              "required": [
                "name",
                "entityType",
                "observations"
              ]
            }
          }
        },
        "required": [
          "entities"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Create multiple new entities in the knowledge graph",
      "outputSchema": {
        "type": "object",
        "properties": {
          "entities": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "The name of the entity"
                },
                "entityType": {
                  "type": "string",
                  "description": "The type of the entity"
                },
                "observations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observation contents associated with the entity"
                }
              },
              "required": [
                "name",
                "entityType",
                "observations"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "entities"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "entities"
      ]
    },
    {
      "name": "memory.createRelations",
      "label": "Create Relations",
      "inputSchema": {
        "type": "object",
        "properties": {
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "from": {
                  "type": "string",
                  "description": "The name of the entity where the relation starts"
                },
                "to": {
                  "type": "string",
                  "description": "The name of the entity where the relation ends"
                },
                "relationType": {
                  "type": "string",
                  "description": "The type of the relation"
                }
              },
              "required": [
                "from",
                "to",
                "relationType"
              ]
            }
          }
        },
        "required": [
          "relations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      "outputSchema": {
        "type": "object",
        "properties": {
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "from": {
                  "type": "string",
                  "description": "The name of the entity where the relation starts"
                },
                "to": {
                  "type": "string",
                  "description": "The name of the entity where the relation ends"
                },
                "relationType": {
                  "type": "string",
                  "description": "The type of the relation"
                }
              },
              "required": [
                "from",
                "to",
                "relationType"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "relations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "relations"
      ]
    },
    {
      "name": "memory.addObservations",
      "label": "Add Observations",
      "inputSchema": {
        "type": "object",
        "properties": {
          "observations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "entityName": {
                  "type": "string",
                  "description": "The name of the entity to add the observations to"
                },
                "contents": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observation contents to add"
                }
              },
              "required": [
                "entityName",
                "contents"
              ]
            }
          }
        },
        "required": [
          "observations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Add new observations to existing entities in the knowledge graph",
      "outputSchema": {
        "type": "object",
        "properties": {
          "results": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "entityName": {
                  "type": "string"
                },
                "addedObservations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "entityName",
                "addedObservations"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "results"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "observations"
      ]
    },
    {
      "name": "memory.deleteEntities",
      "label": "Delete Entities",
      "inputSchema": {
        "type": "object",
        "properties": {
          "entityNames": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "An array of entity names to delete"
          }
        },
        "required": [
          "entityNames"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Delete multiple entities and their associated relations from the knowledge graph",
      "outputSchema": {
        "type": "object",
        "properties": {
          "success": {
            "type": "boolean"
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "success",
          "message"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "entityNames"
      ]
    },
    {
      "name": "memory.deleteObservations",
      "label": "Delete Observations",
      "inputSchema": {
        "type": "object",
        "properties": {
          "deletions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "entityName": {
                  "type": "string",
                  "description": "The name of the entity containing the observations"
                },
                "observations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observations to delete"
                }
              },
              "required": [
                "entityName",
                "observations"
              ]
            }
          }
        },
        "required": [
          "deletions"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Delete specific observations from entities in the knowledge graph",
      "outputSchema": {
        "type": "object",
        "properties": {
          "success": {
            "type": "boolean"
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "success",
          "message"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "deletions"
      ]
    },
    {
      "name": "memory.deleteRelations",
      "label": "Delete Relations",
      "inputSchema": {
        "type": "object",
        "properties": {
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "from": {
                  "type": "string",
                  "description": "The name of the entity where the relation starts"
                },
                "to": {
                  "type": "string",
                  "description": "The name of the entity where the relation ends"
                },
                "relationType": {
                  "type": "string",
                  "description": "The type of the relation"
                }
              },
              "required": [
                "from",
                "to",
                "relationType"
              ]
            },
            "description": "An array of relations to delete"
          }
        },
        "required": [
          "relations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Delete multiple relations from the knowledge graph",
      "outputSchema": {
        "type": "object",
        "properties": {
          "success": {
            "type": "boolean"
          },
          "message": {
            "type": "string"
          }
        },
        "required": [
          "success",
          "message"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "relations"
      ]
    },
    {
      "name": "memory.readGraph",
      "label": "Read Graph",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Read the entire knowledge graph",
      "outputSchema": {
        "type": "object",
        "properties": {
          "entities": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "The name of the entity"
                },
                "entityType": {
                  "type": "string",
                  "description": "The type of the entity"
                },
                "observations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observation contents associated with the entity"
                }
              },
              "required": [
                "name",
                "entityType",
                "observations"
              ],
              "additionalProperties": false
            }
          },
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "from": {
                  "type": "string",
                  "description": "The name of the entity where the relation starts"
                },
                "to": {
                  "type": "string",
                  "description": "The name of the entity where the relation ends"
                },
                "relationType": {
                  "type": "string",
                  "description": "The type of the relation"
                }
              },
              "required": [
                "from",
                "to",
                "relationType"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "entities",
          "relations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      }
    },
    {
      "name": "memory.searchNodes",
      "label": "Search Nodes",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The search query to match against entity names, types, and observation content"
          }
        },
        "required": [
          "query"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Search for nodes in the knowledge graph based on a query",
      "outputSchema": {
        "type": "object",
        "properties": {
          "entities": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "The name of the entity"
                },
                "entityType": {
                  "type": "string",
                  "description": "The type of the entity"
                },
                "observations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observation contents associated with the entity"
                }
              },
              "required": [
                "name",
                "entityType",
                "observations"
              ],
              "additionalProperties": false
            }
          },
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "from": {
                  "type": "string",
                  "description": "The name of the entity where the relation starts"
                },
                "to": {
                  "type": "string",
                  "description": "The name of the entity where the relation ends"
                },
                "relationType": {
                  "type": "string",
                  "description": "The type of the relation"
                }
              },
              "required": [
                "from",
                "to",
                "relationType"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "entities",
          "relations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "query"
      ]
    },
    {
      "name": "memory.openNodes",
      "label": "Open Nodes",
      "inputSchema": {
        "type": "object",
        "properties": {
          "names": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "An array of entity names to retrieve"
          }
        },
        "required": [
          "names"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Open specific nodes in the knowledge graph by their names",
      "outputSchema": {
        "type": "object",
        "properties": {
          "entities": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "The name of the entity"
                },
                "entityType": {
                  "type": "string",
                  "description": "The type of the entity"
                },
                "observations": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "An array of observation contents associated with the entity"
                }
              },
              "required": [
                "name",
                "entityType",
                "observations"
              ],
              "additionalProperties": false
            }
          },
          "relations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "from": {
                  "type": "string",
                  "description": "The name of the entity where the relation starts"
                },
                "to": {
                  "type": "string",
                  "description": "The name of the entity where the relation ends"
                },
                "relationType": {
                  "type": "string",
                  "description": "The type of the relation"
                }
              },
              "required": [
                "from",
                "to",
                "relationType"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "entities",
          "relations"
        ],
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false
      },
      "editableFields": [
        "names"
      ]
    }
  ];
