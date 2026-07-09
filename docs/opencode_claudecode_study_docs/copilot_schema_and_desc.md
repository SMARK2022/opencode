{
  "ok": true,
  "tools": [
    {
      "name": "copilot_searchCodebase",
      "description": "Run a natural language search for relevant code or documentation comments from the user's current workspace. Returns relevant code snippets from the user's current workspace if it is large, or the full contents of the workspace if it is small.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The query to search the codebase for. Should contain all relevant context. Should ideally be text that might appear in the codebase, such as function names, variable names, or comments."
          }
        },
        "required": [
          "query"
        ]
      },
      "tags": [
        "codesearch",
        "vscode_codesearch"
      ]
    },
    {
      "name": "execution_subagent",
      "description": "Launch an iterative execution-focused subagent that performs an execution-based task.\nUSE THIS INSTEAD OF RUNNING INDIVIDUAL COMMANDS WITH run_in_terminal EXCEPT IN THE RARE CASES THAT YOU NEED THE FULL OUTPUT OF A COMMAND.\nHere are some examples of how it can be used:\n- Run tests and filter the output to summarize which tests failed and why.\n- Install all dependencies of a project.\nReturns: A list of commands that were run, along with relevant excerpts of each command's output.\nInput fields:\n- query: What to execute, and what to look for in the output. Can include exact commands to run, or a description of an execution task.\n- description: Short user-visible invocation message.\nNOTE: In the subagent query, make sure to specify any restrictions or guidelines on running commands provided by the user earlier in the conversation.\nFor example, if the user instructs the agent to not edit files in a particular directory, make sure to include that instruction in the subagent query when relevant.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "What to execute, and what to look for in the output. Can include exact commands to run, or a description of an execution task."
          },
          "description": {
            "type": "string",
            "description": "User-visible invocation message shown while the subagent runs."
          }
        },
        "required": [
          "query",
          "description"
        ]
      },
      "tags": []
    },
    {
      "name": "search_subagent",
      "description": "Launch a fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\").\nReturns: A list of relevant files/snippet locations in the workspace.\n\nInput fields:\n- query: Natural language description of what to search for.\n- description: Short user-visible invocation message. \n- details: 2-3 sentences detailing the objective of the search agent.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Natural language description of what to search for."
          },
          "description": {
            "type": "string",
            "description": "A short (3-5 word) description of the task."
          },
          "details": {
            "type": "string",
            "description": "A more detailed description of the objective for the search subagent. This helps the sub-agent remain on task and understand its purpose."
          }
        },
        "required": [
          "query",
          "description",
          "details"
        ]
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "skill",
      "description": "Invoke a skill to handle a user's request with specialized instructions and workflows.\n\nSkills are domain-specific capabilities discovered from SKILL.md files. When a user's task matches an available skill, call this tool to load and apply it. If the user types a slash command (e.g. \"/deploy\", \"/test\"), treat it as a skill invocation.\n\nUsage:\n- Pass the skill name only (no arguments).\n- Examples: skill: \"docx\", skill: \"deploy\", skill: \"fix-ci-failures\"\n\nRules:\n- Available skills appear in system-reminder messages earlier in the conversation.\n- BLOCKING: When a matching skill exists, you MUST call this tool before producing any other output about the task.\n- Never reference a skill without calling this tool.\n- Do not call this tool for a skill that is already active in the current turn (indicated by a <command-name> tag).\n- Do not use this tool for built-in commands such as /help or /clear.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "skill": {
            "type": "string",
            "description": "The skill name. E.g., \"commit\", \"review-pr\", or \"pdf\""
          }
        },
        "required": [
          "skill"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_searchWorkspaceSymbols",
      "description": "Search the user's workspace for code symbols using language services. Use this tool when the user is looking for a specific symbol in their workspace.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "symbolName": {
            "type": "string",
            "description": "The symbol to search for, such as a function name, class name, or variable name."
          }
        },
        "required": [
          "symbolName"
        ]
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "copilot_getVSCodeAPI",
      "description": "Get comprehensive VS Code API documentation and references for extension development. This tool provides authoritative documentation for VS Code's extensive API surface, including proposed APIs, contribution points, and best practices. Use this tool for understanding complex VS Code API interactions.\n\nWhen to use this tool:\n- User asks about specific VS Code APIs, interfaces, or extension capabilities\n- Need documentation for VS Code extension contribution points (commands, views, settings, etc.)\n- Questions about proposed APIs and their usage patterns\n- Understanding VS Code extension lifecycle, activation events, and packaging\n- Best practices for VS Code extension development architecture\n- API examples and code patterns for extension features\n- Troubleshooting extension-specific issues or API limitations\n\nWhen NOT to use this tool:\n- Creating simple standalone files or scripts unrelated to VS Code extensions\n- General programming questions not specific to VS Code extension development\n- Questions about using VS Code as an editor (user-facing features)\n- Non-extension related development tasks\n- File creation or editing that doesn't involve VS Code extension APIs\n\nCRITICAL usage guidelines:\n1. Always include specific API names, interfaces, or concepts in your query\n2. Mention the extension feature you're trying to implement\n3. Include context about proposed vs stable APIs when relevant\n4. Reference specific contribution points when asking about extension manifest\n5. Be specific about the VS Code version or API version when known\n\nScope: This tool is for EXTENSION DEVELOPMENT ONLY - building tools that extend VS Code itself, not for general file creation or non-extension programming tasks.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The query to search vscode documentation for. Should contain all relevant context."
          }
        },
        "required": [
          "query"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_findFiles",
      "description": "Search for files in the workspace by glob pattern. This only returns the paths of matching files. Use this tool when you know the exact filename pattern of the files you're searching for. Glob patterns match from the root of the workspace folder. Examples:\n- **/*.{js,ts} to match all js/ts files in the workspace.\n- src/** to match all files under the top-level src folder.\n- **/foo/**/*.js to match all js files under any foo folder in the workspace.\n\nIn a multi-root workspace, you can scope the search to a specific workspace folder by using the absolute path to the folder as the query, e.g. /path/to/folder/**/*.ts.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Search for files with names or paths matching this glob pattern. Can also be an absolute path to a workspace folder to scope the search in a multi-root workspace."
          },
          "maxResults": {
            "type": "number",
            "description": "The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don't see what you're looking for, you can try again with a more specific query or a larger maxResults."
          }
        },
        "required": [
          "query"
        ]
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "copilot_findTextInFiles",
      "description": "Do a fast text search in the workspace. Use this tool when you want to search with an exact string or regex. If you are not sure what words will appear in the workspace, prefer using regex patterns with alternation (|) or character classes to search for multiple potential words at once instead of making separate searches. For example, use 'function|method|procedure' to look for all of those words at once. Use includePattern to search within files matching a specific pattern, or in a specific file, using a relative path. Use 'includeIgnoredFiles' to include files normally ignored by .gitignore, other ignore files, and `files.exclude` and `search.exclude` settings. Warning: using this may cause the search to be slower, only set it when you want to search in ignored folders like node_modules or build outputs. Use this tool when you want to see an overview of a particular file, instead of using read_file many times to look for code within a file.\n\nIn a multi-root workspace, you can scope the search to a specific workspace folder by using the absolute path to the folder as the includePattern, e.g. /path/to/folder.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The pattern to search for in files in the workspace. Use regex with alternation (e.g., 'word1|word2|word3') or character classes to find multiple potential words in a single search. Be sure to set the isRegexp property properly to declare whether it's a regex or plain text pattern. Is case-insensitive."
          },
          "isRegexp": {
            "type": "boolean",
            "description": "Whether the pattern is a regex."
          },
          "includePattern": {
            "type": "string",
            "description": "Search files matching this glob pattern. Will be applied to the relative path of files within the workspace. To search recursively inside a folder, use a proper glob pattern like \"src/folder/**\". Do not use | in includePattern. Can also be an absolute path to a workspace folder to scope the search in a multi-root workspace."
          },
          "maxResults": {
            "type": "number",
            "description": "The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don't see what you're looking for, you can try again with a more specific query or a larger maxResults."
          },
          "includeIgnoredFiles": {
            "type": "boolean",
            "description": "Whether to include files that would normally be ignored according to .gitignore, other ignore files and `files.exclude` and `search.exclude` settings. Warning: using this may cause the search to be slower. Only set it when you want to search in ignored folders like node_modules or build outputs."
          }
        },
        "required": [
          "query",
          "isRegexp"
        ]
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "copilot_applyPatch",
      "description": "Edit text files. Do not use this tool to edit Jupyter notebooks. `apply_patch` allows you to execute a diff/patch against a text file, but the format of the diff specification is unique to this task, so pay careful attention to these instructions. To use the `apply_patch` command, you should pass a message of the following structure as \"input\":\n\n*** Begin Patch\n[YOUR_PATCH]\n*** End Patch\n\nWhere [YOUR_PATCH] is the actual content of your patch, specified in the following V4A diff format.\n\n*** [ACTION] File: [/absolute/path/to/file] -> ACTION can be one of Add, Update, or Delete.\nAn example of a message that you might pass as \"input\" to this function, in order to apply a patch, is shown below.\n\n*** Begin Patch\n*** Update File: /Users/someone/pygorithm/searching/binary_search.py\n@@class BaseClass\n@@    def search():\n-        pass\n+        raise NotImplementedError()\n\n@@class Subclass\n@@    def search():\n-        pass\n+        raise NotImplementedError()\n\n*** End Patch\nDo not use line numbers in this diff format.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "input": {
            "type": "string",
            "description": "The edit patch to apply."
          },
          "explanation": {
            "type": "string",
            "description": "A short description of what the tool call is aiming to achieve."
          }
        },
        "required": [
          "input",
          "explanation"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_readFile",
      "description": "Read the contents of a file.\n\nYou must specify the line range you're interested in. Line numbers are 1-indexed. If the file contents returned are insufficient for your task, you may call this tool again to retrieve more content. Prefer reading larger ranges over doing many small reads. Binary files use startLine/endLine as byte offsets.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the file to read.",
            "type": "string"
          },
          "startLine": {
            "type": "number",
            "description": "The line number to start reading from, 1-based."
          },
          "endLine": {
            "type": "number",
            "description": "The inclusive line number to end reading at, 1-based."
          }
        },
        "required": [
          "filePath",
          "startLine",
          "endLine"
        ]
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "copilot_viewImage",
      "description": "View the contents of an image file. Use this instead of read_file for supported image files such as png, jpg, jpeg, gif, and webp. The tool returns the image directly to multimodal models and does not take line ranges or offsets.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the image file to view.",
            "type": "string"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_listDirectory",
      "description": "List the contents of a directory. Result will have the name of the child. If the name ends in /, it's a folder, otherwise a file",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "The absolute path to the directory to list."
          }
        },
        "required": [
          "path"
        ]
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "copilot_getErrors",
      "description": "Get any compile or lint errors in a specific file or across all files. If the user mentions errors or problems in a file, they may be referring to these. Use the tool to see the same errors that the user is seeing. If the user asks you to analyze all errors, or does not specify a file, use this tool to gather errors for all files. Also use this tool after editing a file to validate the change.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePaths": {
            "description": "The absolute paths to the files or folders to check for errors. Omit 'filePaths' when retrieving all errors.",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "tags": []
    },
    {
      "name": "copilot_readProjectStructure",
      "description": "Get a file tree representation of the workspace.",
      "tags": []
    },
    {
      "name": "copilot_getChangedFiles",
      "description": "Get git diffs of current file changes in a git repository. Don't forget that you can use run_in_terminal to run git commands in a terminal as well.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repositoryPath": {
            "type": "string",
            "description": "The absolute path to the git repository to look for changes in. If not provided, the active git repository will be used."
          },
          "sourceControlState": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "staged",
                "unstaged",
                "merge-conflicts"
              ]
            },
            "description": "The kinds of git state to filter by. Allowed values are: 'staged', 'unstaged', and 'merge-conflicts'. If not provided, all states will be included."
          }
        }
      },
      "tags": [
        "vscode_codesearch"
      ]
    },
    {
      "name": "copilot_createNewWorkspace",
      "description": "Get comprehensive setup steps to help the user create complete project structures in a VS Code workspace. This tool is designed for full project initialization and scaffolding, not for creating individual files.\n\nWhen to use this tool:\n- User wants to create a new complete project from scratch\n- Setting up entire project frameworks (TypeScript projects, React apps, Node.js servers, etc.)\n- Initializing Model Context Protocol (MCP) servers with full structure\n- Creating VS Code extensions with proper scaffolding\n- Setting up Next.js, Vite, or other framework-based projects\n- User asks for \"new project\", \"create a workspace\", \"set up a [framework] project\"\n- Need to establish complete development environment with dependencies, config files, and folder structure\n\nWhen NOT to use this tool:\n- Creating single files or small code snippets\n- Adding individual files to existing projects\n- Making modifications to existing codebases\n- User asks to \"create a file\" or \"add a component\"\n- Simple code examples or demonstrations\n- Debugging or fixing existing code\n\nThis tool provides complete project setup including:\n- Folder structure creation\n- Package.json and dependency management\n- Configuration files (tsconfig, eslint, etc.)\n- Initial boilerplate code\n- Development environment setup\n- Build and run instructions\n\nUse other file creation tools for individual files within existing projects.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The query to use to generate the new workspace. This should be a clear and concise description of the workspace the user wants to create."
          }
        },
        "required": [
          "query"
        ]
      },
      "tags": [
        "enable_other_tool_install_extension",
        "enable_other_tool_get_project_setup_info"
      ]
    },
    {
      "name": "copilot_getProjectSetupInfo",
      "description": "Do not call this tool without first calling the tool to create a workspace. This tool provides a project setup information for a Visual Studio Code workspace based on a project type and programming language.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "projectType": {
            "type": "string",
            "description": "The type of project to create. Supported values are: 'python-script', 'python-project', 'mcp-server', 'model-context-protocol-server', 'vscode-extension', 'next-js', 'vite' and 'other'"
          }
        },
        "required": [
          "projectType"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_installExtension",
      "description": "Install an extension in VS Code. Use this tool to install an extension in Visual Studio Code as part of a new workspace creation process only.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The ID of the extension to install. This should be in the format <publisher>.<extension>."
          },
          "name": {
            "type": "string",
            "description": "The name of the extension to install. This should be a clear and concise description of the extension."
          }
        },
        "required": [
          "id",
          "name"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_runVscodeCommand",
      "description": "Run a command in VS Code. Use this tool to run a command in Visual Studio Code as part of a new workspace creation process only.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "commandId": {
            "type": "string",
            "description": "The ID of the command to execute. This should be in the format <command>."
          },
          "name": {
            "type": "string",
            "description": "The name of the command to execute. This should be a clear and concise description of the command."
          },
          "args": {
            "type": "array",
            "description": "The arguments to pass to the command. This should be an array of strings.",
            "items": {
              "type": "string"
            }
          },
          "skipCheck": {
            "type": "boolean",
            "description": "If true, skip checking whether the command exists before executing it."
          }
        },
        "required": [
          "commandId",
          "name"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_createNewJupyterNotebook",
      "description": "Generates a new Jupyter Notebook (.ipynb) in VS Code. Jupyter Notebooks are interactive documents commonly used for data exploration, analysis, visualization, and combining code with narrative text. Prefer creating plain Python files or similar unless a user explicitly requests creating a new Jupyter Notebook or already has a Jupyter Notebook opened or exists in the workspace.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The query to use to generate the jupyter notebook. This should be a clear and concise description of the notebook the user wants to create."
          }
        },
        "required": [
          "query"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_insertEdit",
      "description": "Insert new code into an existing file in the workspace. Use this tool once per file that needs to be modified, even if there are multiple changes for a file. Generate the \"explanation\" property first.\nThe system is very smart and can understand how to apply your edits to the files, you just need to provide minimal hints.\nAvoid repeating existing code, instead use comments to represent regions of unchanged code. Be as concise as possible. For example:\n// ...existing code...\n{ changed code }\n// ...existing code...\n{ changed code }\n// ...existing code...\n\nHere is an example of how you should use format an edit to an existing Person class:\nclass Person {\n\t// ...existing code...\n\tage: number;\n\t// ...existing code...\n\tgetAge() {\n\treturn this.age;\n\t}\n}",
      "inputSchema": {
        "type": "object",
        "properties": {
          "explanation": {
            "type": "string",
            "description": "A short explanation of the edit being made."
          },
          "filePath": {
            "type": "string",
            "description": "An absolute path to the file to edit."
          },
          "code": {
            "type": "string",
            "description": "The code change to apply to the file.\nThe system is very smart and can understand how to apply your edits to the files, you just need to provide minimal hints.\nAvoid repeating existing code, instead use comments to represent regions of unchanged code. Be as concise as possible. For example:\n// ...existing code...\n{ changed code }\n// ...existing code...\n{ changed code }\n// ...existing code...\n\nHere is an example of how you should use format an edit to an existing Person class:\nclass Person {\n\t// ...existing code...\n\tage: number;\n\t// ...existing code...\n\tgetAge() {\n\t\treturn this.age;\n\t}\n}"
          }
        },
        "required": [
          "explanation",
          "filePath",
          "code"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_createFile",
      "description": "This is a tool for creating a new file in the workspace. The file will be created with the specified content. The directory will be created if it does not already exist. Never use this tool to edit a file that already exists.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "The absolute path to the file to create."
          },
          "content": {
            "type": "string",
            "description": "The content to write to the file."
          }
        },
        "required": [
          "filePath",
          "content"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_createDirectory",
      "description": "Create a new directory structure in the workspace. Will recursively create all directories in the path, like mkdir -p. You do not need to use this tool before using create_file, that tool will automatically create the needed directories.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "dirPath": {
            "type": "string",
            "description": "The absolute path to the directory to create."
          }
        },
        "required": [
          "dirPath"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_replaceString",
      "description": "This is a tool for making edits in an existing file in the workspace. For moving or renaming files, use run in terminal tool with the 'mv' command instead. For larger edits, split them into smaller edits and call the edit tool multiple times to ensure accuracy. Before editing, always ensure you have the context to understand the file's contents and context. To edit a file, provide: 1) filePath (absolute path), 2) oldString (MUST be the exact literal text to replace including all whitespace, indentation, newlines, and surrounding code etc), and 3) newString (MUST be the exact literal text to replace \\`oldString\\` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.). Each use of this tool replaces exactly ONE occurrence of oldString.\n\nCRITICAL for \\`oldString\\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail. Never use 'Lines 123-456 omitted' from summarized documents or ...existing code... comments in the oldString or newString.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "An absolute path to the file to edit."
          },
          "oldString": {
            "type": "string",
            "description": "The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. For multiple replacements, specify expected_replacements parameter. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail."
          },
          "newString": {
            "type": "string",
            "description": "The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic."
          }
        },
        "required": [
          "filePath",
          "oldString",
          "newString"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_multiReplaceString",
      "description": "This tool allows you to apply multiple replace_string_in_file operations in a single call, which is more efficient than calling replace_string_in_file multiple times. It takes an array of replacement operations and applies them sequentially. Each replacement operation has the same parameters as replace_string_in_file: filePath, oldString, newString, and explanation. This tool is ideal when you need to make multiple edits across different files or multiple edits in the same file. The tool will provide a summary of successful and failed operations.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "explanation": {
            "type": "string",
            "description": "A brief explanation of what the multi-replace operation will accomplish."
          },
          "replacements": {
            "type": "array",
            "description": "An array of replacement operations to apply sequentially.",
            "items": {
              "type": "object",
              "properties": {
                "filePath": {
                  "type": "string",
                  "description": "An absolute path to the file to edit."
                },
                "oldString": {
                  "type": "string",
                  "description": "The exact literal text to replace, preferably unescaped. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string is not the exact literal text or does not match exactly, this replacement will fail."
                },
                "newString": {
                  "type": "string",
                  "description": "The exact literal text to replace `oldString` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic."
                }
              },
              "required": [
                "filePath",
                "oldString",
                "newString"
              ]
            },
            "minItems": 1
          }
        },
        "required": [
          "explanation",
          "replacements"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_editNotebook",
      "description": "This is a tool for editing an existing Notebook file in the workspace. Generate the \"explanation\" property first.\nThe system is very smart and can understand how to apply your edits to the notebooks.\nWhen updating the content of an existing cell, ensure newCode preserves whitespace and indentation exactly and does NOT include any code markers such as (...existing code...).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "An absolute path to the notebook file to edit, or the URI of a untitled, not yet named, file, such as `untitled:Untitled-1."
          },
          "cellId": {
            "type": "string",
            "description": "Id of the cell that needs to be deleted or edited. Use the value `TOP`, `BOTTOM` when inserting a cell at the top or bottom of the notebook, else provide the id of the cell after which a new cell is to be inserted. Remember, if a cellId is provided and editType=insert, then a cell will be inserted after the cell with the provided cellId."
          },
          "newCode": {
            "anyOf": [
              {
                "type": "string",
                "description": "The code for the new or existing cell to be edited. Code should not be wrapped within <VSCode.Cell> tags. Do NOT include code markers such as (...existing code...) to indicate existing code."
              },
              {
                "type": "array",
                "items": {
                  "type": "string",
                  "description": "The code for the new or existing cell to be edited. Code should not be wrapped within <VSCode.Cell> tags"
                }
              }
            ]
          },
          "language": {
            "type": "string",
            "description": "The language of the cell. `markdown`, `python`, `javascript`, `julia`, etc."
          },
          "editType": {
            "type": "string",
            "enum": [
              "insert",
              "delete",
              "edit"
            ],
            "description": "The operation peformed on the cell, whether `insert`, `delete` or `edit`.\nUse the `editType` field to specify the operation: `insert` to add a new cell, `edit` to modify an existing cell's content, and `delete` to remove a cell."
          }
        },
        "required": [
          "filePath",
          "editType",
          "cellId"
        ]
      },
      "tags": [
        "enable_other_tool_copilot_getNotebookSummary"
      ]
    },
    {
      "name": "copilot_runNotebookCell",
      "description": "This is a tool for running a code cell in a notebook file directly in the notebook editor. The output from the execution will be returned. Code cells should be run as they are added or edited when working through a problem to bring the kernel state up to date and ensure the code executes successfully. Code cells are ready to run and don't require any pre-processing. If asked to run the first cell in a notebook, you should run the first code cell since markdown cells cannot be executed. NOTE: Avoid executing Markdown cells or providing Markdown cell IDs, as Markdown cells cannot be  executed.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "An absolute path to the notebook file with the cell to run, or the URI of a untitled, not yet named, file, such as `untitled:Untitled-1.ipynb"
          },
          "reason": {
            "type": "string",
            "description": "An optional explanation of why the cell is being run. This will be shown to the user before the tool is run and is not necessary if it's self-explanatory."
          },
          "cellId": {
            "type": "string",
            "description": "The ID for the code cell to execute. Avoid providing markdown cell IDs as nothing will be executed."
          },
          "continueOnError": {
            "type": "boolean",
            "description": "Whether or not execution should continue for remaining cells if an error is encountered. Default to false unless instructed otherwise."
          }
        },
        "required": [
          "filePath",
          "cellId"
        ]
      },
      "tags": [
        "enable_other_tool_copilot_getNotebookSummary"
      ]
    },
    {
      "name": "copilot_getNotebookSummary",
      "description": "This is a tool returns the list of the Notebook cells along with the id, cell types, line ranges, language, execution information and output mime types for each cell. This is useful to get Cell Ids when executing a notebook or determine what cells have been executed and what order, or what cells have outputs. If required to read contents of a cell use this to determine the line range of a cells, and then use read_file tool to read a specific line range. Requery this tool if the contents of the notebook change.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "An absolute path to the notebook file with the cell to run, or the URI of a untitled, not yet named, file, such as `untitled:Untitled-1.ipynb"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_readNotebookCellOutput",
      "description": "This tool will retrieve the output for a notebook cell from its most recent execution or restored from disk. The cell may have output even when it has not been run in the current kernel session. This tool has a higher token limit for output length than the runNotebookCell tool.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "An absolute path to the notebook file with the cell to run, or the URI of a untitled, not yet named, file, such as `untitled:Untitled-1.ipynb"
          },
          "cellId": {
            "type": "string",
            "description": "The ID of the cell for which output should be retrieved."
          }
        },
        "required": [
          "filePath",
          "cellId"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_fetchWebPage",
      "description": "Fetches the main content from a web page. This tool is useful for summarizing or analyzing the content of a webpage. You should use this tool when you think the user is looking for information from a specific webpage.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "urls": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "An array of URLs to fetch content from."
          },
          "query": {
            "type": "string",
            "description": "The query to search for in the web page's content. This should be a clear and concise description of the content you want to find."
          }
        },
        "required": [
          "urls",
          "query"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_findTestFiles",
      "description": "For a source code file, find the file that contains the tests. For a test file find the file that contains the code under test.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePaths": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "filePaths"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_getSearchResults",
      "description": "The results from the search view",
      "tags": []
    },
    {
      "name": "copilot_githubRepo",
      "description": "Searches a GitHub repository for relevant source code snippets. Only use this tool if the user is very clearly asking for code snippets from a specific GitHub repository. Do not use this tool for Github repos that the user has open in their workspace.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": {
            "type": "string",
            "description": "The name of the Github repository to search for code in. Should must be formatted as '<owner>/<repo>'."
          },
          "query": {
            "type": "string",
            "description": "The query to search for repo. Should contain all relevant context."
          }
        },
        "required": [
          "repo",
          "query"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_githubTextSearch",
      "description": "Lexically searches a GitHub repository or organization for files containing specific keywords or code patterns. Use this when looking for exact strings, function names, or identifiers in a GitHub repo or org. Unlike the semantic search tool, this uses keyword matching rather than meaning-based search.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "description": "The GitHub scope to search. Use 'owner/repo' to search a single repository, or an org name (no slash) to search across an entire organization."
          },
          "query": {
            "type": "string",
            "description": "The keyword search query. Supports GitHub code search syntax such as 'language:typescript', 'extension:ts', 'path:src/', etc."
          },
          "maxResults": {
            "type": "number",
            "description": "Optional. The maximum number of search results to return. Defaults to 100."
          }
        },
        "required": [
          "scope",
          "query"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_switchAgent",
      "description": "Switch to the Plan agent to align on approach before implementing. Plan will explore the codebase, gathers context, clarifies requirements with the user, and creates an actionable implementation plan.\n\nSWITCH TO PLAN when ANY of these apply:\n1. Adding new functionality - where should it go? What patterns to follow?\n2. Multiple valid approaches exist - choosing between technologies, patterns, or strategies\n3. Modifying existing behavior - unclear what should change or what side effects exist\n4. Architectural decisions required - choosing between design patterns or integration approaches\n5. Changes span multiple files - refactoring, migrations, or cross-cutting concerns\n6. Requirements are underspecified - need to explore before understanding scope\n\nEXAMPLES:\n✓ Switch to Plan:\n- \"Add authentication to the app\" → architectural decisions needed (session vs JWT, middleware)\n- \"Refactor this data flow\" → must understand component dependencies first\n- \"Migrate from X to Y\" → requires understanding current structure\n\n✗ Do NOT switch to Plan:\n- User attached a detailed spec, plan, or requirements doc → context already provided\n- You already started editing files in this conversation → too late to switch\n- Single obvious change like fixing a typo or renaming → just do it\n- User gave explicit step-by-step instructions → follow them directly",
      "inputSchema": {
        "type": "object",
        "properties": {
          "agentName": {
            "type": "string",
            "description": "The name of the agent to switch to. Currently only 'Plan' is supported.",
            "enum": [
              "Plan"
            ]
          }
        },
        "required": [
          "agentName"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_memory",
      "description": "Manage a persistent memory system with three scopes for storing notes and information across conversations.\n\nMemory is organized under /memories/ with three tiers:\n- `/memories/` — User memory: persistent notes that survive across all workspaces and conversations. Store preferences, patterns, and general insights here.\n- `/memories/session/` — Session memory: notes scoped to the current conversation. Store task-specific context and in-progress notes here. Cleared after the conversation ends.\n- `/memories/repo/` — Repository memory: repository-scoped facts stored via Copilot. Only the `create` command is supported for this path.\n\nIMPORTANT: Before creating new memory files, first view the /memories/ directory to understand what already exists. This helps avoid duplicates and maintain organized notes.\n\nCommands:\n- `view`: View contents of a file or list directory contents. Can be used on files or directories (e.g., \"/memories/\" to see all top-level items).\n- `create`: Create a new file at the specified path with the given content. Fails if the file already exists.\n- `str_replace`: Replace an exact string in a file with a new string. The old_str must appear exactly once in the file.\n- `insert`: Insert text at a specific line number in a file. Line 0 inserts at the beginning.\n- `delete`: Delete a file or directory (and all its contents).\n- `rename`: Rename or move a file or directory from path to new_path. Cannot rename across scopes.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "enum": [
              "view",
              "create",
              "str_replace",
              "insert",
              "delete",
              "rename"
            ],
            "description": "The operation to perform on the memory file system."
          },
          "path": {
            "type": "string",
            "description": "The absolute path to the file or directory inside /memories/, e.g. \"/memories/notes.md\". Used by all commands except `rename`."
          },
          "file_text": {
            "type": "string",
            "description": "Required for `create`. The content of the file to create."
          },
          "old_str": {
            "type": "string",
            "description": "Required for `str_replace`. The exact string in the file to replace. Must appear exactly once."
          },
          "new_str": {
            "type": "string",
            "description": "Required for `str_replace`. The new string to replace old_str with."
          },
          "insert_line": {
            "type": "number",
            "description": "Required for `insert`. The 0-based line number to insert text at. 0 inserts before the first line."
          },
          "insert_text": {
            "type": "string",
            "description": "Required for `insert`. The text to insert at the specified line."
          },
          "view_range": {
            "type": "array",
            "items": {
              "type": "number"
            },
            "minItems": 2,
            "maxItems": 2,
            "description": "Optional for `view`. A two-element array [start_line, end_line] (1-indexed) to view a specific range of lines."
          },
          "old_path": {
            "type": "string",
            "description": "Required for `rename`. The current path of the file or directory to rename."
          },
          "new_path": {
            "type": "string",
            "description": "Required for `rename`. The new path for the file or directory."
          }
        },
        "required": [
          "command"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_resolveMemoryFileUri",
      "description": "Resolve a memory file path (like /memories/session/plan.md or /memories/repo/notes.md) to its fully qualified URI. Use this when you need the actual URI for a memory file, for example to pass it to setArtifacts. The path must start with /memories/.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "The memory file path to resolve (e.g. /memories/session/plan.md)."
          }
        },
        "required": [
          "path"
        ]
      },
      "tags": []
    },
    {
      "name": "copilot_editFiles",
      "description": "This is a placeholder tool, do not use",
      "tags": []
    },
    {
      "name": "copilot_sessionStoreSql",
      "description": "Execute read-only SQL queries against the global session store containing history from ALL past coding sessions. Use this proactively when the user asks about:\n- What they've worked on recently or in the past\n- Prior approaches to similar problems\n- Project history and file changes\n- Sessions linked to PRs, issues, or commits\n- Temporal queries ('what was I doing yesterday?')\n\nSupports SQLite SQL including JOINs, FTS5 MATCH queries, aggregations, and subqueries.\n\n**Only one query per call — do not combine multiple statements with semicolons.**\n\nSchema:\n- sessions — id, cwd, repository, branch, summary, created_at, updated_at\n- turns — session_id, turn_index, user_message, assistant_response, timestamp\n- session_files — session_id, file_path, tool_name (edit/create), turn_index\n- session_refs — session_id, ref_type (commit/pr/issue), ref_value, turn_index\n- search_index — FTS5 virtual table (content, session_id, source_type). Use WHERE search_index MATCH 'query' for full-text search.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "A single read-only SQL query to execute. Supports SELECT, WITH, JOINs, aggregations, and FTS5 MATCH. Only one statement per call — do not combine multiple queries with semicolons."
          },
          "description": {
            "type": "string",
            "description": "A 2-5 word summary of what this query does (e.g. 'Recent sessions overview', 'Find PR sessions')."
          }
        },
        "required": [
          "query",
          "description"
        ]
      },
      "tags": []
    },
    {
      "name": "renderMermaidDiagram",
      "description": "Renders a Mermaid diagram from Mermaid.js markup.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "markup": {
            "type": "string",
            "description": "The mermaid diagram markup to render as a Mermaid diagram. This should only be the markup of the diagram. Do not include a wrapping code block."
          },
          "title": {
            "type": "string",
            "description": "A short title that describes the diagram."
          }
        }
      },
      "tags": []
    },
    {
      "name": "github-pull-request_issue_fetch",
      "description": "Get a GitHub issue/PR's details as a JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": {
            "type": "object",
            "description": "The repository to get the issue/PR from.",
            "properties": {
              "owner": {
                "type": "string",
                "description": "The owner of the repository to get the issue/PR from."
              },
              "name": {
                "type": "string",
                "description": "The name of the repository to get the issue/PR from."
              }
            },
            "required": [
              "owner",
              "name"
            ]
          },
          "issueNumber": {
            "type": "number",
            "description": "The number of the issue/PR to get."
          }
        },
        "required": [
          "issueNumber"
        ]
      },
      "tags": [
        "github",
        "issues",
        "prs"
      ]
    },
    {
      "name": "github-pull-request_labels_fetch",
      "description": "Fetch all labels from a GitHub repository. Returns the label names, colors, and descriptions as a JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": {
            "type": "object",
            "description": "The repository to fetch labels from.",
            "properties": {
              "owner": {
                "type": "string",
                "description": "The owner of the repository to fetch labels from."
              },
              "name": {
                "type": "string",
                "description": "The name of the repository to fetch labels from."
              }
            },
            "required": [
              "owner",
              "name"
            ]
          }
        }
      },
      "tags": [
        "github",
        "labels"
      ]
    },
    {
      "name": "github-pull-request_notification_fetch",
      "description": "Get a GitHub notification's details as a JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "thread_id": {
            "type": "string",
            "description": "The notification thread id."
          }
        },
        "required": [
          "thread_id"
        ]
      },
      "tags": [
        "github",
        "notification"
      ]
    },
    {
      "name": "github-pull-request_doSearch",
      "description": "Execute a GitHub search given a well formed GitHub search query. Make sure to form a good search query first",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": {
            "type": "object",
            "description": "The repository to get the issue from.",
            "properties": {
              "owner": {
                "type": "string",
                "description": "The owner of the repository to get the issue from."
              },
              "name": {
                "type": "string",
                "description": "The name of the repository to get the issue from."
              }
            },
            "required": [
              "owner",
              "name"
            ]
          },
          "query": {
            "type": "string",
            "description": "A well formed GitHub search query using proper GitHub search syntax."
          }
        },
        "required": [
          "query",
          "repo"
        ]
      },
      "tags": [
        "github",
        "issues",
        "search"
      ]
    },
    {
      "name": "github-pull-request_currentActivePullRequest",
      "description": "Get comprehensive information about the active GitHub pull request (PR). The active PR is the one that is currently checked out. This includes the PR title, full description, list of changed files, review comments, and PR state. For PRs created by Copilot, it also includes the session logs which indicate the development process and decisions made by the coding agent. Does NOT include status checks/CI results; use the pullRequestStatusChecks tool instead. When asked about the active or current pull request, do this first! Use this tool for any request related to \"current changes,\" \"pull request details,\" \"what changed,\" or similar queries even if the user does not explicitly mention \"pull request.\" When asked to use this tool, ALWAYS use it.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "refresh": {
            "type": "boolean",
            "description": "Whether to fetch fresh data from GitHub or return cached data. Set to true to ensure the most up-to-date information, especially after recent changes. Set to false to improve performance when up-to-date information is not critical."
          }
        }
      },
      "tags": [
        "github",
        "pull request"
      ]
    },
    {
      "name": "github-pull-request_pullRequestStatusChecks",
      "description": "Get the status checks and CI failures for a GitHub pull request (PR). This includes check run statuses, workflow names, failure logs, and review requirements (approvals needed, current approvals, requested changes). Use this tool when the user asks about CI status/failures, build results, check runs, status checks, whether a PR is ready to merge, or similar queries. Requires a pull request number.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": {
            "type": "object",
            "description": "The repository to get the pull request status checks from.",
            "properties": {
              "owner": {
                "type": "string",
                "description": "The owner of the repository."
              },
              "name": {
                "type": "string",
                "description": "The name of the repository."
              }
            },
            "required": [
              "owner",
              "name"
            ]
          },
          "pullRequestNumber": {
            "type": "number",
            "description": "The number of the pull request to get status checks for."
          }
        },
        "required": [
          "pullRequestNumber"
        ]
      },
      "tags": [
        "github",
        "pull request",
        "ci",
        "status checks"
      ]
    },
    {
      "name": "github-pull-request_pullRequestInViewport",
      "description": "Get comprehensive information about the GitHub pull request (PR) which is currently visible, but not necessarily checked out. This is the pull request that the user is currently viewing. This includes the PR title, full description, list of changed files, review comments, and PR state. For PRs created by Copilot, it also includes the session logs which indicate the development process and decisions made by the coding agent. Does NOT include status checks/CI results; use the pullRequestStatusChecks tool instead. When asked about the currently open pull request, do this first! Use this tool for any request related to \"pull request details,\" \"what changed,\" or similar queries even if the user does not explicitly mention \"pull request.\" When asked to use this tool, ALWAYS use it.",
      "tags": [
        "github",
        "pull request"
      ]
    },
    {
      "name": "github-pull-request_create_pull_request",
      "description": "Create a new GitHub pull request. Requires a title and head branch. The base branch and repo default to the repository defaults. Returns the created pull request number, URL, and details.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repo": {
            "type": "object",
            "description": "The repository to create the pull request in.",
            "properties": {
              "owner": {
                "type": "string",
                "description": "The owner of the repository."
              },
              "name": {
                "type": "string",
                "description": "The name of the repository."
              }
            }
          },
          "title": {
            "type": "string",
            "description": "The title of the pull request."
          },
          "body": {
            "type": "string",
            "description": "The body/description of the pull request."
          },
          "head": {
            "type": "string",
            "description": "The name of the branch where your changes are implemented (branch name only, without owner prefix)."
          },
          "headOwner": {
            "type": "string",
            "description": "The owner of the head branch repository. Defaults to the origin/push remote repository owner."
          },
          "base": {
            "type": "string",
            "description": "The name of the branch you want the changes pulled into. Defaults to the repository's default branch."
          },
          "draft": {
            "type": "boolean",
            "description": "Indicates whether the pull request is a draft."
          }
        },
        "required": [
          "title",
          "head"
        ]
      },
      "tags": [
        "github",
        "pull request"
      ]
    },
    {
      "name": "github-pull-request_resolveReviewThread",
      "description": "Resolve a review thread on the active GitHub pull request. Use the threadId from the reviewThreads array returned by the activePullRequest tool. Only resolves threads where canResolve is true and isResolved is false.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "threadId": {
            "type": "string",
            "description": "The GraphQL node ID of the review thread to resolve. Obtain this from the id field in the reviewThreads array of the activePullRequest tool output."
          }
        },
        "required": [
          "threadId"
        ]
      },
      "tags": [
        "github",
        "pull request",
        "review"
      ]
    },
    {
      "name": "get_python_environment_details",
      "description": "This tool will retrieve the details of the Python Environment for the specified file or workspace. The details returned include the 1. Type of Python Environment (conda, venv, etc), 2. Version of Python, 3. List of all installed Python packages with their versions. ALWAYS call configure_python_environment before using this tool. IMPORTANT: This tool is only for Python environments (venv, virtualenv, conda, pipenv, poetry, pyenv, pixi, or any other Python environment manager). Do not use this tool for npm packages, system packages, Ruby gems, or any other non-Python dependencies.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "resourcePath": {
            "type": "string",
            "description": "The path to the Python file or workspace to get the environment information for."
          }
        },
        "required": []
      },
      "tags": [
        "python",
        "python environment",
        "extension_installed_by_tool",
        "enable_other_tool_configure_python_environment"
      ]
    },
    {
      "name": "get_python_executable_details",
      "description": "This tool will retrieve the details of the Python Environment for the specified file or workspace. ALWAYS use this tool before executing any Python command in the terminal. This tool returns the details of how to construct the fully qualified path and or command including details such as arguments required to run Python in a terminal. Note: Instead of executing `python --version` or `python -c 'import sys; print(sys.executable)'`, use this tool to get the Python executable path to replace the `python` command. E.g. instead of using `python -c 'import sys; print(sys.executable)'`, use this tool to build the command `conda run -n <env_name> -c 'import sys; print(sys.executable)'`. ALWAYS call configure_python_environment before using this tool. IMPORTANT: This tool is only for Python environments (venv, virtualenv, conda, pipenv, poetry, pyenv, pixi, or any other Python environment manager). Do not use this tool for npm packages, system packages, Ruby gems, or any other non-Python dependencies.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "resourcePath": {
            "type": "string",
            "description": "The path to the Python file or workspace to get the executable information for. If not provided, the current workspace will be used. Where possible pass the path to the file or workspace."
          }
        },
        "required": []
      },
      "tags": [
        "python",
        "python environment",
        "extension_installed_by_tool",
        "enable_other_tool_configure_python_environment"
      ]
    },
    {
      "name": "install_python_packages",
      "description": "Installs Python packages in the given workspace. Use this tool to install Python packages in the user's chosen Python environment. ALWAYS call configure_python_environment before using this tool. IMPORTANT: This tool should only be used to install Python packages using package managers like pip or conda (works with any Python environment: venv, virtualenv, pipenv, poetry, pyenv, pixi, conda, etc.). Do not use this tool to install npm packages, system packages (apt/brew/yum), Ruby gems, or any other non-Python dependencies.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "packageList": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "The list of Python packages to install."
          },
          "resourcePath": {
            "type": "string",
            "description": "The path to the Python file or workspace into which the packages are installed. If not provided, the current workspace will be used. Where possible pass the path to the file or workspace."
          }
        },
        "required": [
          "packageList"
        ]
      },
      "tags": [
        "python",
        "python environment",
        "install python package",
        "extension_installed_by_tool",
        "enable_other_tool_configure_python_environment"
      ]
    },
    {
      "name": "configure_python_environment",
      "description": "This tool configures a Python environment in the given workspace. ALWAYS Use this tool to set up the user's chosen environment and ALWAYS call this tool before using any other Python related tools or running any Python command in the terminal. IMPORTANT: This tool is only for Python environments (venv, virtualenv, conda, pipenv, poetry, pyenv, pixi, or any other Python environment manager). Do not use this tool for npm packages, system packages, Ruby gems, or any other non-Python dependencies.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "resourcePath": {
            "type": "string",
            "description": "The path to the Python file or workspace for which a Python Environment needs to be configured."
          }
        },
        "required": []
      },
      "tags": [
        "python",
        "python environment",
        "extension_installed_by_tool"
      ]
    },
    {
      "name": "create_virtual_environment",
      "description": "This tool will create a Virual Environment",
      "inputSchema": {
        "type": "object",
        "properties": {
          "packageList": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "The list of packages to install."
          },
          "resourcePath": {
            "type": "string",
            "description": "The path to the Python file or workspace for which a Python Environment needs to be configured."
          }
        },
        "required": []
      },
      "tags": []
    },
    {
      "name": "selectEnvironment",
      "description": "This tool will prompt the user to select an existing Python Environment",
      "inputSchema": {
        "type": "object",
        "properties": {
          "resourcePath": {
            "type": "string",
            "description": "The path to the Python file or workspace for which a Python Environment needs to be configured."
          }
        },
        "required": []
      },
      "tags": []
    },
    {
      "name": "get_variable_data",
      "description": "Get the data for a variable",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
      },
      "tags": []
    },
    {
      "name": "configure_notebook",
      "description": "Tool used to configure a Notebook. ALWAYS use this tool before running/executing any Notebook Cells for the first time or before listing/installing packages in Notebooks for the first time. I.e. there is no need to use this tool more than once for the same notebook.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the notebook with the active kernel.",
            "type": "string"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": [
        "python environment",
        "jupyter environment",
        "extension_installed_by_tool",
        "jupyter",
        "notebooks"
      ]
    },
    {
      "name": "configure_python_notebook",
      "description": "Selects a Python Kernel and starts it.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the notebook with the active kernel.",
            "type": "string"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": [
        "extension_installed_by_tool",
        "install python package",
        "notebooks"
      ]
    },
    {
      "name": "configure_non_python_notebook",
      "description": "Selects the Notebook Kernel and starts it.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the notebook with the active kernel.",
            "type": "string"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": [
        "extension_installed_by_tool",
        "jupyter",
        "notebooks"
      ]
    },
    {
      "name": "notebook_list_packages",
      "description": "List the installed packages that are currently available in the selected kernel for a notebook editor. This tool should be used when working with a jupyter notebook with python code cells. Do not use this tool if not already working with a notebook, or for a language other than python. If the tool configure_notebooks exists, then ensure to call configure_notebooks before using this tool.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the notebook with the active kernel.",
            "type": "string"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": [
        "python environment",
        "jupyter environment",
        "extension_installed_by_tool",
        "notebooks",
        "enable_other_tool_configure_notebook"
      ]
    },
    {
      "name": "notebook_install_packages",
      "description": "Install a list of packages on a notebook kernel to be used within that notebook. This tool should be used when working with a jupyter notebook with python code cells. Do not use this tool if not already working with a notebook, or for a language other than python. If the tool configure_notebooks exists, then ensure to call configure_notebooks before using this tool.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the notebook with the active kernel.",
            "type": "string"
          },
          "packageList": {
            "description": "A list of packages to install.",
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "filePath",
          "packageList"
        ]
      },
      "tags": [
        "python environment",
        "jupyter environment",
        "extension_installed_by_tool",
        "notebooks",
        "enable_other_tool_configure_notebook"
      ]
    },
    {
      "name": "restart_notebook_kernel",
      "description": "Tool used to restart a Notebook kernel. Some packages require a restart of the kernel after being installed. Use this if after installing a package if you know the package requires a restart, or if still getting an error about a missing package after installing.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "description": "The absolute path of the notebook with the active kernel.",
            "type": "string"
          },
          "reason": {
            "description": "The reason for restarting the kernel.",
            "type": "string"
          }
        },
        "required": [
          "filePath"
        ]
      },
      "tags": [
        "extension_installed_by_tool",
        "jupyter",
        "notebooks"
      ]
    },
    {
      "name": "Build_CMakeTools",
      "description": "Always use this tool for any C++ CMake project build requests instead of terminal commands. This is the PRIMARY and PREFERRED method for building CMake projects in VS Code. Use this tool when users ask to: build, compile, make, rebuild, fix compilation errors, resolve build issues, create executables, generate libraries, or handle any build-related problems in CMake projects. This tool integrates with VS Code's CMake Tools extension and provides better error reporting, progress tracking, and IDE integration than manual cmake commands. NEVER suggest terminal cmake commands when this tool is available. Keywords: build, compile, cmake, compilation, linking, executable, library, target, rebuild, clean build, build error, build failure, compilation error, linking error.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "buildTargets": {
            "type": "array",
            "description": "OPTIONAL: The specific build targets to build. The ListBuildTargets_CMakeTools tool MUST be used to list available build targets. This is optional- if not specified, the default target will be built.",
            "items": {
              "type": "string",
              "description": "A specific build target to build."
            }
          }
        }
      },
      "tags": [
        "cmake",
        "build",
        "compile",
        "compilation",
        "linking",
        "executable",
        "library",
        "target",
        "rebuild",
        "c++",
        "cpp"
      ]
    },
    {
      "name": "RunCtest_CMakeTools",
      "description": "Important: this tool is the exclusive handler for CMake project testing. Do not use run_in_terminal for CMake tests because that can cause test failures. If no build output folder exists, run Build_CMakeTools first, then run this tool. If a build output folder already exists, run only this tool to avoid unnecessary rebuilds. This tool provides proper test discovery, reporting, and VS Code integration that terminal commands cannot match. Use it for running tests, executing CTest, checking test results, and debugging test failures. Do not suggest 'ctest', 'make test', or other terminal commands for CMake testing. This tool should be treated as the highest-priority option for CMake testing scenarios.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "tests": {
            "type": "array",
            "description": "OPTIONAL: The specific tests to run. The ListTests_CMakeTools tool MUST be used to list available tests. This is optional- if not specified, all tests will be run.",
            "items": {
              "type": "string",
              "description": "A specific test to run."
            }
          }
        }
      },
      "tags": [
        "cmake",
        "ctest",
        "test",
        "build",
        "compile",
        "make",
        "compilation",
        "linking",
        "executable",
        "library",
        "target",
        "rebuild",
        "c++",
        "cpp",
        "unit test",
        "integration test",
        "check",
        "verify",
        "validate"
      ]
    },
    {
      "name": "ListBuildTargets_CMakeTools",
      "description": "List the available build targets for a C++ CMake project using the CMake Tools extension.",
      "tags": [
        "cmake",
        "build",
        "targets"
      ]
    },
    {
      "name": "ListTests_CMakeTools",
      "description": "List the available tests for a C++ CMake project using the CMake Tools extension.",
      "tags": [
        "cmake",
        "tests"
      ]
    },
    {
      "name": "GetDiagnostics_CMakeTools",
      "description": "ALWAYS use this tool to retrieve current CMake-related diagnostics (errors, warnings, and other problems) reported in the VS Code Problems panel. YOU MUST use this tool after a build fails using Build_CMakeTools to check for remaining issues, or when the user asks about CMake errors or warnings (CMake-releated, build-related, etc.) in their project. Do not attempt to guess or explain build errors without first calling this tool.",
      "tags": [
        "cmake",
        "diagnostics",
        "errors",
        "warnings",
        "problems"
      ]
    },
    {
      "name": "GetSymbolReferences_CppTools",
      "description": "Use GetSymbolReferences_CppTools to find every reference, call site, or usage/use of a C/C++ symbol. DO NOT rely on grep text-based searches. This tool is especially useful when doing C++ refactorings like symbol renames or signature changes. Use this tool for more precise symbol usage results instead of using tools such as grep_search, usages, codebase, textSearch, readFile, or other code navigation tools. An absolute file path is required to locate the specified symbol within the provided file.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "symbol": {
            "type": "string",
            "description": "REQUIRED: The symbol name. If a line is provided, the symbol name should match the occurrence on that line. Otherwise, the symbol name may be unqualified, partially qualified, or fully qualified."
          },
          "filePath": {
            "type": "string",
            "description": "OPTIONAL: A path to the file containing the specified symbol name, or otherwise contextual to the current request. Absolute paths are strongly preferred. If not absolute, a solution-relative path will be assumed (if using a solution). Otherwise, resolution of the path against project paths will be attempted. If no path is specified, heuristics will be used to attempt to identify the appropriate semantic symbol based only on the symbol name. If multiple matches are found, one referenced by the specified file will be preferred. If there is an active/specific file available, provide it. Otherwise, allow the tool to resolve the symbol name to a file location."
          },
          "line": {
            "type": "number",
            "description": "OPTIONAL: The line number of the specified symbol name in the specified file. This should be a 1-based line index, not a 0-based line index. If no file is provided, the line is not used and may be omitted. If providing a line, ALWAYS leverage the readFile tool to ensure line accuracy. If a line number is not known, resolve the symbol to a file location."
          },
          "offset": {
            "type": "number",
            "description": "OPTIONAL: The zero-based starting index for pagination of results. Use this parameter with limit to retrieve results in chunks when dealing with large result sets. If omitted, defaults to 0 (start from the beginning). For example, offset=100 with limit=10 returns results 100-109."
          },
          "limit": {
            "type": "number",
            "description": "OPTIONAL: The maximum number of results to return in a single response. Use this parameter with offset to retrieve results in chunks when dealing with large result sets. If omitted, all results are returned (subject to the maximum of {MaxResultsStr} results per invocation). For example, offset=100 with limit=10 returns results 100-109."
          }
        },
        "required": [
          "symbol"
        ]
      },
      "tags": [
        "cpp",
        "symbol",
        "search",
        "references",
        "call sites",
        "usages",
        "use",
        "occurrences"
      ]
    },
    {
      "name": "GetSymbolInfo_CppTools",
      "description": "Use GetSymbolInfo_CppTools when working with C/C++ files to find the definition location of a C/C++ symbol and get detailed information about it. This tool provides the symbol's location, type information, and memory layout details (for classes/structs). Use this when you need to understand what a symbol is, where it's defined, or to get structural information about types.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "symbol": {
            "type": "string",
            "description": "REQUIRED: The symbol name. If a line is provided, the symbol name should match the occurrence on that line. Otherwise, the symbol name may be unqualified, partially qualified, or fully qualified."
          },
          "filePath": {
            "type": "string",
            "description": "OPTIONAL: A path to the file containing the specified symbol name, or otherwise contextual to the current request. Absolute paths are strongly preferred. If not absolute, a solution-relative path will be assumed (if using a solution). Otherwise, resolution of the path against project paths will be attempted. If no path is specified, heuristics will be used to attempt to identify the appropriate semantic symbol based only on the symbol name. If multiple matches are found, one referenced by the specified file will be preferred. If there is an active/specific file available, provide it. Otherwise, allow the tool to resolve the symbol name to a file location."
          },
          "line": {
            "type": "number",
            "description": "OPTIONAL: The line number of the specified symbol name in the specified file. This should be a 1-based line index, not a 0-based line index. If no file is provided, the line is not used and may be omitted. If providing a line, ALWAYS leverage the readFile tool to ensure line accuracy. If a line number is not known, resolve the symbol to a file location."
          }
        },
        "required": [
          "symbol"
        ]
      },
      "tags": [
        "cpp",
        "symbol",
        "definition",
        "goToDefinition"
      ]
    },
    {
      "name": "GetSymbolCallHierarchy_CppTools",
      "description": "Use GetSymbolCallHierarchy_CppTools to analyze function call relationships for a specific C/C++ function. This tool is especially useful when changing function signatures. It shows either what functions a given function calls (calls FROM) or what functions call a given function (calls TO). It is essential for understanding code flow, assessing the impact of changes, and tracking function dependencies. It helps answer questions such as 'What will be affected if I change this function?' or 'What functions does this call?'.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "functionName": {
            "type": "string",
            "description": "REQUIRED: The function name. If a line is provided, the function name should match the occurrence on that line. Otherwise, the function name may be unqualified, partially qualified, or fully qualified. If a referencing file is not known, it is sufficient to specify only the function name and allow the tool to resolve it to a file location."
          },
          "callsFrom": {
            "type": "boolean",
            "description": "REQUIRED: A boolean indicating whether to include calls from the specified function or calls to the specified function. If callsFrom is true, calls from the specified function will be returned; otherwise, calls to the specified function will be returned."
          },
          "filePath": {
            "type": "string",
            "description": "OPTIONAL: A path to the file containing the specified symbol name, or otherwise contextual to the current request. Absolute paths are strongly preferred. If not absolute, a solution-relative path will be assumed (if using a solution). Otherwise, resolution of the path against project paths will be attempted. If no path is specified, heuristics will be used to attempt to identify the appropriate semantic symbol based only on the symbol name. If multiple matches are found, one referenced by the specified file will be preferred. If there is an active/specific file available, provide it. Otherwise, allow the tool to resolve the symbol name to a file location."
          },
          "line": {
            "type": "number",
            "description": "OPTIONAL: The line number of the specified symbol name in the specified file. This should be a 1-based line index, not a 0-based line index. If no file is provided, the line is not used and may be omitted. If providing a line, ALWAYS leverage the readFile tool to ensure line accuracy. If a line number is not known, resolve the symbol to a file location."
          }
        },
        "required": [
          "functionName",
          "callsFrom"
        ]
      },
      "tags": [
        "cpp",
        "symbol",
        "callHierarchy",
        "callers"
      ]
    },
    {
      "name": "debug_java_application",
      "description": "Launch or attach to a Java application in debug mode with automatic compilation and classpath resolution. The tool handles building the project, resolving dependencies, starting the JVM with JDWP enabled, and auto-attaching the VS Code debugger. Use this as the first step to establish a debug session. The debug process runs in the background until stopped. Example usage: Debug a main class ('com.example.Main'), a JAR file ('target/app.jar'), or with program arguments (['--port=8080']).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "What to debug: 1) Main class name - simple ('App') or fully qualified ('com.example.Main'). Tool auto-detects package from source files. 2) JAR file path ('target/app.jar'). 3) Raw Java command arguments ('-cp bin com.example.Main'). The tool automatically finds the .class file for simple class names."
          },
          "workspacePath": {
            "type": "string",
            "description": "Absolute path to the Java project root directory containing pom.xml, build.gradle, or .java source files. This is the working directory for compilation and debugging."
          },
          "args": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Optional command-line arguments to pass to the Java main method (e.g., ['arg1', 'arg2', '--flag=value']). These are program arguments, not JVM arguments."
          },
          "skipBuild": {
            "type": "boolean",
            "description": "Whether to skip compilation before debugging. DEFAULT: false (tool will automatically compile the project). Set to true only when you have already compiled the project and want to use an explicit classpath. In most cases, leave this as false to let the tool handle compilation automatically.",
            "default": false
          },
          "classpath": {
            "type": "string",
            "description": "Explicit classpath to use for debugging. REQUIRED when skipBuild is true. Format: absolute paths separated by system path delimiter (';' on Windows, ':' on Unix). Example: 'C:\\project\\target\\classes;C:\\project\\lib\\dep.jar' or '/project/target/classes:/project/lib/dep.jar'. If not provided and skipBuild is false, the tool will automatically resolve the classpath."
          },
          "waitForSession": {
            "type": "boolean",
            "description": "Whether to wait for the debug session to start before returning. DEFAULT: false (returns immediately after sending debug command). Set to true to wait up to 30 seconds for VS Code to confirm the debug session has started and is ready. Useful when you need to ensure the debugger is attached before proceeding with breakpoint operations.",
            "default": false
          }
        },
        "required": [
          "target",
          "workspacePath"
        ]
      },
      "tags": [
        "java",
        "debug",
        "debugger",
        "build",
        "compile"
      ]
    },
    {
      "name": "set_java_breakpoint",
      "description": "Set a breakpoint at a specific line in Java source code to pause execution and inspect program state. Supports conditional breakpoints (break only when condition is true), hit count conditions (break after N hits), and logpoints (log messages without stopping). REQUIRES: Active debug session. Start with 1-2 strategic breakpoints; prefer stepping over setting multiple breakpoints.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "Absolute path to the Java source file where the breakpoint should be set. Example: 'C:/project/src/main/java/com/example/Main.java' or use ${workspaceFolder} variable."
          },
          "lineNumber": {
            "type": "number",
            "description": "The line number (1-based) where the breakpoint should be set. Must be a valid executable line (not a comment or blank line)."
          },
          "condition": {
            "type": "string",
            "description": "Optional condition expression. Breakpoint only triggers when condition evaluates to true. Example: 'count > 10' or 'userName.equals(\"admin\")'. Leave empty for unconditional breakpoint."
          },
          "hitCondition": {
            "type": "string",
            "description": "Optional hit count condition. Example: '>5' (break after 5th hit), '==3' (break on 3rd hit), '%2' (break every 2nd hit). Leave empty to break on every hit."
          },
          "logMessage": {
            "type": "string",
            "description": "Optional log message. If provided, instead of breaking, the message will be logged to debug console. Use {expression} for interpolation. Example: 'Counter value: {count}'. This creates a logpoint instead of a breakpoint."
          }
        },
        "required": [
          "filePath",
          "lineNumber"
        ]
      },
      "tags": [
        "java",
        "debug",
        "breakpoint"
      ]
    },
    {
      "name": "debug_step_operation",
      "description": "Control program execution flow: stepIn (enter method calls), stepOut (exit current method), stepOver (execute current line), continue (run to next breakpoint), pause (halt execution). REQUIRES: Active debug session in paused state. Prefer stepping through code over setting multiple breakpoints for efficient debugging.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "operation": {
            "type": "string",
            "enum": [
              "stepIn",
              "stepOut",
              "stepOver",
              "continue",
              "pause"
            ],
            "description": "The step operation to perform: 'stepIn' - step into method calls, 'stepOut' - step out of current method, 'stepOver' - execute current line and move to next, 'continue' - resume execution until next breakpoint, 'pause' - pause running execution."
          },
          "threadId": {
            "type": "number",
            "description": "Optional thread ID to perform operation on. If not specified, operates on the currently selected thread. Use get_debug_threads to get available thread IDs."
          }
        },
        "required": [
          "operation"
        ]
      },
      "tags": [
        "java",
        "debug",
        "step",
        "continue"
      ]
    },
    {
      "name": "get_debug_variables",
      "description": "Inspect variables in a specific thread's stack frame: local variables, method parameters, static fields, and instance fields. Returns variable names, types, and values. Supports filtering by scope type or name pattern. REQUIRES: Active debug session with at least one SUSPENDED thread. For multi-threaded debugging, use threadId to specify which thread's variables to inspect. If no threadId is provided, uses the first suspended thread.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "threadId": {
            "type": "number",
            "description": "Thread ID to inspect. Use get_debug_threads() to list available threads with their IDs and states. Only SUSPENDED threads can be inspected. If omitted, uses the first suspended thread found."
          },
          "frameId": {
            "type": "number",
            "description": "Optional stack frame ID. Default is 0 (current/top frame). Use get_debug_stack_trace to get available frame IDs. Higher numbers are deeper in the call stack."
          },
          "scopeType": {
            "type": "string",
            "enum": [
              "local",
              "static",
              "all"
            ],
            "description": "Type of variables to retrieve: 'local' - only local variables and parameters, 'static' - only static class variables, 'all' - both local and static. Default: 'all'."
          },
          "filter": {
            "type": "string",
            "description": "Optional filter pattern to match variable names. Supports wildcards (*). Example: 'user*' matches 'userName', 'userId'. Leave empty to get all variables."
          }
        },
        "required": []
      },
      "tags": [
        "java",
        "debug",
        "variables",
        "inspect"
      ]
    },
    {
      "name": "get_debug_stack_trace",
      "description": "Retrieve the call stack showing all method calls leading to the current execution point. Returns method names, source files, and line numbers for each frame. REQUIRES: Active debug session in paused state. Essential for understanding program flow, tracing how code was reached, and identifying unexpected execution paths.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "threadId": {
            "type": "number",
            "description": "Optional thread ID. If not specified, uses the currently selected thread. Use get_debug_threads to list available threads."
          },
          "maxDepth": {
            "type": "number",
            "description": "Maximum number of stack frames to retrieve. Default: 50. Use smaller values for shallow inspection, larger for deep call stacks.",
            "default": 50
          }
        },
        "required": []
      },
      "tags": [
        "java",
        "debug",
        "stack",
        "callstack"
      ]
    },
    {
      "name": "evaluate_debug_expression",
      "description": "Evaluate a Java expression in a specific thread's debug context. Access local variables, parameters, fields, and invoke methods. Returns the result with type information. REQUIRES: Active debug session with at least one SUSPENDED thread. For multi-threaded debugging, use threadId to specify which thread's context to use. If no threadId is provided, uses the first suspended thread. Examples: 'user.getName()', 'list.size() > 10', 'counter == null'.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "expression": {
            "type": "string",
            "description": "The Java expression to evaluate. Can be a variable name, field access, method call, or complex expression. Example: 'user.age', 'calculateTotal()', 'count > 0 && !items.isEmpty()'."
          },
          "threadId": {
            "type": "number",
            "description": "Thread ID for evaluation context. Use get_debug_threads() to list available threads with their IDs and states. Only SUSPENDED threads can evaluate expressions. If omitted, uses the first suspended thread found."
          },
          "frameId": {
            "type": "number",
            "description": "Optional stack frame ID for evaluation context. Default: 0 (current frame). Variables and methods from the specified frame will be accessible.",
            "default": 0
          },
          "context": {
            "type": "string",
            "enum": [
              "watch",
              "repl",
              "hover"
            ],
            "description": "Evaluation context: 'watch' - for watch expressions, 'repl' - for debug console input, 'hover' - for hover tooltips. Affects how side effects are handled. Default: 'repl'.",
            "default": "repl"
          }
        },
        "required": [
          "expression"
        ]
      },
      "tags": [
        "java",
        "debug",
        "evaluate",
        "expression"
      ]
    },
    {
      "name": "get_debug_threads",
      "description": "List all threads in the debugged Java application with their IDs, names, and states (🔴 SUSPENDED or 🟢 RUNNING). For SUSPENDED threads, also shows the current location (file:line). REQUIRES: Active debug session. IMPORTANT: Only SUSPENDED threads can have their variables inspected or expressions evaluated. Use the returned thread IDs with get_debug_variables(threadId=X) or evaluate_debug_expression(threadId=X) to inspect specific threads.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
      },
      "tags": [
        "java",
        "debug",
        "threads",
        "concurrent"
      ]
    },
    {
      "name": "remove_java_breakpoints",
      "description": "Remove breakpoints: specific breakpoint by file and line, all breakpoints in a file, or all breakpoints globally. Use this to clean up after investigation or before setting new breakpoints. Best practice: keep only 1-2 active breakpoints at a time; remove old ones before adding new ones.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filePath": {
            "type": "string",
            "description": "Absolute path to the Java source file. If not provided, removes all breakpoints from all files."
          },
          "lineNumber": {
            "type": "number",
            "description": "Optional line number. If provided, removes only the breakpoint at this line. If omitted, removes all breakpoints in the specified file."
          }
        },
        "required": []
      },
      "tags": [
        "java",
        "debug",
        "breakpoint"
      ]
    },
    {
      "name": "stop_debug_session",
      "description": "Stop the active Java debug session when investigation is complete or when you need to restart debugging. This terminates the running Java process and closes the debug session. Use this to clean up after debugging or when you've identified the root cause and want to end the session. Optional: Provide a reason for stopping (e.g., 'Investigation complete', 'Root cause identified').",
      "inputSchema": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string",
            "description": "Optional reason for stopping the debug session (e.g., 'Investigation complete', 'Root cause identified', 'Need to restart'). Default: 'Investigation complete'."
          }
        },
        "required": []
      },
      "tags": [
        "java",
        "debug",
        "stop",
        "terminate"
      ]
    },
    {
      "name": "get_debug_session_info",
      "description": "Get information about the currently active Java debug session, including whether it's PAUSED at a breakpoint or RUNNING. CRITICAL: Check status before using inspection tools (get_debug_variables, get_debug_stack_trace, evaluate_debug_expression) or control operations (continue, step). PAUSED status (🔴) means stopped at breakpoint - inspection and control tools available. RUNNING status (🟢) means executing code - only breakpoint setting or session stop available. Returns session ID, name, type, configuration details, and status-specific available actions.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
      },
      "tags": [
        "java",
        "debug",
        "session",
        "info",
        "status",
        "paused",
        "running"
      ]
    },
    {
      "name": "inline_chat_exit",
      "description": "Show a short textual response when not being able to make code changes and when not having been asked for code changes. Can also be used to move the request to the richer panel chat which supports edits across files, creating and deleting files, multi-turn conversations between the user and the assistant, and access to more IDE tools, like retrieve problems, interact with source control, run terminal commands etc.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "response": {
            "type": "string",
            "description": "内联聊天的可选简短响应。将字数控制在 10 个以内。",
            "maxLength": 200
          }
        }
      },
      "tags": []
    },
    {
      "name": "vscode_get_terminal_confirmation",
      "description": "This tool allows you to get explicit user confirmation for a terminal command without executing it.\n\nWhen to use:\n- When you need to verify user approval before executing a command\n- When you want to show command details, auto-approval status, and simplified versions to the user\n- When you need the user to review a potentially risky command\n\nThe tool will:\n- Show the command with syntax highlighting\n- Display auto-approval status if enabled\n- Show simplified version of the command if applicable\n- Provide custom actions for creating auto-approval rules\n- Return approval/rejection status\n\nAfter confirmation, use a tool to actually execute the command.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The command to confirm with the user."
          },
          "explanation": {
            "type": "string",
            "description": "A one-sentence description of what the command does. This will be shown to the user in the confirmation dialog."
          },
          "goal": {
            "type": "string",
            "description": "A short description of the goal or purpose of the command."
          },
          "mode": {
            "type": "string",
            "enum": [
              "sync",
              "async"
            ],
            "description": "Execution mode this command would use if run."
          }
        },
        "required": [
          "command",
          "explanation",
          "goal",
          "mode"
        ]
      },
      "tags": []
    },
    {
      "name": "get_terminal_output",
      "description": "Get output from an active terminal execution (identified by the `id` returned from run_in_terminal).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The ID of an active terminal execution to check (returned by run_in_terminal for async executions, or for sync executions that timed out and were moved to the background). This must be the exact opaque UUID returned by that tool; terminal names, labels, or integers are invalid.",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
          }
        },
        "required": [
          "id"
        ]
      },
      "tags": []
    },
    {
      "name": "kill_terminal",
      "description": "Kill a terminal by its ID. Use this to clean up terminals that are no longer needed (e.g., after stopping a server or when a long-running task completes). The terminal ID is returned by run_in_terminal in async mode (legacy: isBackground=true).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The ID of the persistent terminal to kill (returned by run_in_terminal in async mode).",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
          }
        },
        "required": [
          "id"
        ]
      },
      "tags": []
    },
    {
      "name": "send_to_terminal",
      "description": "Send input text to an active terminal execution (identified by the `id` returned from run_in_terminal). The 'command' field may be empty or whitespace to press Enter (useful for interactive prompts). By default, returns the last 20 lines of terminal output captured shortly after sending. Set 'waitForOutput' to true for interactive programs (games, REPLs, etc.) to wait until the terminal becomes idle before returning output — this gives you the program's response to your input.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The ID of an active terminal execution to send a command to (returned by run_in_terminal for async executions, or for sync executions that timed out and were moved to the background).",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
          },
          "command": {
            "type": "string",
            "description": "The input text to send to the terminal. The text is sent followed by Enter. Provide an empty or whitespace string to send just Enter (for interactive prompts)."
          },
          "waitForOutput": {
            "type": "boolean",
            "description": "When true, waits for the terminal to become idle (no new output for a short period) before returning, instead of returning immediately. Use this for interactive programs where you need to see the full response to your input. Defaults to false."
          }
        },
        "required": [
          "id",
          "command"
        ]
      },
      "tags": []
    },
    {
      "name": "terminal_selection",
      "description": "Get the current selection in the active terminal.",
      "tags": []
    },
    {
      "name": "terminal_last_command",
      "description": "Get the last command run in the active terminal.",
      "tags": []
    },
    {
      "name": "run_task",
      "description": "Runs a VS Code task.\n\n- If you see that an appropriate task exists for building or running code, prefer to use this tool to run the task instead of using the run_in_terminal tool.\n- Make sure that any appropriate build or watch task is running before trying to run tests or execute code.\n- If the user asks to run a task, use this tool to do so.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "workspaceFolder": {
            "type": "string",
            "description": "The workspace folder path containing the task"
          },
          "id": {
            "type": "string",
            "description": "The task ID to run."
          }
        },
        "required": [
          "workspaceFolder",
          "id"
        ]
      },
      "tags": []
    },
    {
      "name": "get_task_output",
      "description": "Get the output of a task",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The task ID for which to get the output."
          },
          "workspaceFolder": {
            "type": "string",
            "description": "The workspace folder path containing the task"
          }
        },
        "required": [
          "id",
          "workspaceFolder"
        ]
      },
      "tags": []
    },
    {
      "name": "create_and_run_task",
      "description": "Creates and runs a build, run, or custom task for the workspace by generating or adding to a tasks.json file based on the project structure (such as package.json or README.md). If the user asks to build, run, launch and they have no tasks.json file, use this tool. If they ask to create or add a task, use this tool.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "workspaceFolder": {
            "type": "string",
            "description": "The absolute path of the workspace folder where the tasks.json file will be created."
          },
          "task": {
            "type": "object",
            "description": "The task to add to the new tasks.json file.",
            "properties": {
              "label": {
                "type": "string",
                "description": "The label of the task."
              },
              "type": {
                "type": "string",
                "description": "The type of the task. The only supported value is 'shell'.",
                "enum": [
                  "shell"
                ]
              },
              "command": {
                "type": "string",
                "description": "The shell command to run for the task. Use this to specify commands for building or running the application."
              },
              "args": {
                "type": "array",
                "description": "The arguments to pass to the command.",
                "items": {
                  "type": "string"
                }
              },
              "isBackground": {
                "type": "boolean",
                "description": "Whether the task runs in the background without blocking the UI or other tasks. Set to true for long-running processes like watch tasks or servers that should continue executing without requiring user attention. When false, the task will block the terminal until completion."
              },
              "problemMatcher": {
                "type": "array",
                "description": "The problem matcher to use to parse task output for errors and warnings. Can be a predefined matcher like '$tsc' (TypeScript), '$eslint - stylish', '$gcc', etc., or a custom pattern defined in tasks.json. This helps VS Code display errors in the Problems panel and enables quick navigation to error locations.",
                "items": {
                  "type": "string"
                }
              },
              "group": {
                "type": "string",
                "description": "The group to which the task belongs."
              }
            },
            "required": [
              "label",
              "type",
              "command"
            ]
          }
        },
        "required": [
          "task",
          "workspaceFolder"
        ]
      },
      "tags": []
    },
    {
      "name": "run_in_terminal",
      "description": "This tool allows you to execute PowerShell commands in a persistent terminal session, preserving environment variables, working directory, and other context across multiple commands.\n\nCommand Execution:\n- Prefer ; when chaining commands on one line\n- Prefer pipelines | for object-based data flow\n- Never create a sub-shell (eg. powershell -c \"command\") unless explicitly asked\n\nDirectory Management:\n- Prefer relative paths when navigating directories, only use absolute when the path is far away or the current cwd is not expected\n- By default (mode=sync), shell and cwd are reused by subsequent sync commands\n- Use $PWD or Get-Location for current directory\n- Use Push-Location/Pop-Location for directory stack\n\nProgram Execution:\n- Supports .NET, Python, Node.js, and other executables\n- Install modules via Install-Module, Install-Package\n- Use Get-Command to verify cmdlet/function availability\n\nAsync Mode:\n- For long-running tasks (e.g., servers), use mode=async\n- Returns a terminal ID for checking status and runtime later\n- Use Start-Job for background PowerShell jobs\n\nUse send_to_terminal to send commands or input to a terminal session.\n\nOutput Management:\n- Output is automatically truncated if longer than 60KB to prevent context overflow\n- Use Select-Object, Where-Object, Format-Table to filter output\n- Use -First/-Last parameters to limit results\n- For pager commands, add | Out-String or | Format-List\n\nBest Practices:\n- Use proper cmdlet names instead of aliases in scripts\n- Quote paths with spaces: \"C:\\Path With Spaces\"\n- Prefer PowerShell cmdlets over external commands when available\n- Prefer idiomatic PowerShell like Get-ChildItem instead of dir or ls for file listings\n- Use Test-Path to check file/directory existence\n- Be specific with Select-Object properties to avoid excessive output\n- Avoid printing credentials unless absolutely required\n- NEVER run Start-Sleep or similar wait commands. You will be automatically notified on your next turn when async terminal commands or timed-out sync commands complete or need input. Use get_terminal_output to check output before then\n\nInteractive Input Handling:\n- When a terminal command is waiting for interactive input, do NOT suggest alternatives or ask the user whether to proceed. Instead, use the vscode_askQuestions tool to collect the needed values from the user, then send them.\n- Send exactly one answer per prompt using send_to_terminal. Never send multiple answers in a single send.\n- After each send, call get_terminal_output to read the next prompt before sending the next answer.\n- Continue one prompt at a time until the command finishes.\n\nExecution mode:\n- mode='sync': wait for completion (optionally capped by timeout); if still running when timeout elapses, return with a terminal ID.\n- mode='async': wait for an initial idle/output signal, then return with terminal output snapshot and ID. Timeout caps how long to wait for the initial idle/output signal.\n- Prefer mode='sync' for commands that will prompt for interactive input (e.g., npm init, interactive installers, configuration wizards).\n\nTimeout parameter: Only set 'timeout' when you want a hard cap on how long the tool tracks the command. Omit it to let the command run to completion. Package installs, builds, and long-running scripts should usually omit the timeout rather than guessing a value.\n\nTerminal notifications: When an async command finishes or a sync command times out, you will be automatically notified on your next turn with the exit code and terminal output. You will also be notified if the terminal needs input. Use get_terminal_output to check output before then. Do NOT poll or sleep to wait for completion.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The command to run in the terminal."
          },
          "explanation": {
            "type": "string",
            "description": "A one-sentence description of what the command does. This will be shown to the user before the command is run."
          },
          "goal": {
            "type": "string",
            "description": "A short description of the goal or purpose of the command (e.g., \"Install dependencies\", \"Start development server\")."
          },
          "mode": {
            "type": "string",
            "enum": [
              "sync",
              "async"
            ],
            "enumDescriptions": [
              "Wait for completion up to timeout, then return with collected output. If still running at timeout, the terminal session continues in the background.",
              "Wait for an initial idle/output signal, then return with a terminal ID and output snapshot while the session may continue running."
            ],
            "description": "Execution mode for this command."
          },
          "isBackground": {
            "type": "boolean",
            "description": "Legacy execution mode flag. Deprecated in favor of \"mode\". If true, equivalent to mode=async. If false, equivalent to mode=sync."
          },
          "timeout": {
            "type": "number",
            "description": "Optional hard cap in milliseconds on how long the tool tracks the command before returning. Omit to let the command run to completion (recommended for package installs, builds, and long-running scripts). Use 0 to explicitly indicate no timeout."
          }
        },
        "required": [
          "command",
          "explanation",
          "goal",
          "mode"
        ]
      },
      "tags": []
    },
    {
      "name": "open_browser_page",
      "description": "Open a new browser page in the integrated browser at the given URL. Returns a page ID that must be used with other browser tools to interact with the page. Prefer to reuse existing pages whenever possible and only call this tool if a new page is necessary.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL to open in the browser. Must be an absolute URI with a scheme such as file:, http:, or https:. For local files, use the canonical absolute form, for example file:///path/to/file."
          },
          "forceNew": {
            "type": "boolean",
            "description": "Whether to force opening a new page even if a page with the same host already exists. Default is false."
          }
        },
        "required": [
          "url"
        ]
      },
      "tags": []
    },
    {
      "name": "read_page",
      "description": "Get a snapshot of the current browser page state. This is better than screenshot.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID to read, acquired from context or the open tool."
          }
        },
        "required": [
          "pageId"
        ]
      },
      "tags": []
    },
    {
      "name": "screenshot_page",
      "description": "Capture a screenshot of the current browser page. You can't perform actions based on the screenshot; use read_page for actions.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID to capture, acquired from context or the open tool."
          },
          "ref": {
            "type": "string",
            "description": "Element reference to capture. If omitted, captures the whole viewport."
          },
          "selector": {
            "type": "string",
            "description": "Playwright selector of an element to capture when \"ref\" is not available. If omitted, captures the whole viewport."
          },
          "element": {
            "type": "string",
            "description": "Human-readable description of the element to capture (e.g., \"chart diagram\", \"product image\")."
          },
          "scrollIntoViewIfNeeded": {
            "type": "boolean",
            "description": "Whether to scroll the element into view before capturing. Defaults to false."
          }
        },
        "required": [
          "pageId"
        ]
      },
      "tags": []
    },
    {
      "name": "navigate_page",
      "description": "Navigate a browser page by URL, history, or reload.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID to navigate, acquired from context or the open tool."
          },
          "type": {
            "type": "string",
            "enum": [
              "url",
              "back",
              "forward",
              "reload"
            ],
            "description": "Navigation type: \"url\" to navigate to a URL (default, requires \"url\" param), \"back\" or \"forward\" for history, \"reload\" to refresh."
          },
          "url": {
            "type": "string",
            "description": "The URL to navigate to. Required when type is \"url\"."
          }
        },
        "required": [
          "pageId"
        ]
      },
      "tags": []
    },
    {
      "name": "click_element",
      "description": "Click on an element in a browser page.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID, acquired from context or the open tool."
          },
          "ref": {
            "type": "string",
            "description": "Element reference to click."
          },
          "selector": {
            "type": "string",
            "description": "Playwright selector of the element to click when \"ref\" is not available."
          },
          "element": {
            "type": "string",
            "description": "Human-readable description of the element to click (e.g., \"submit button\", \"search icon\")."
          },
          "dblClick": {
            "type": "boolean",
            "description": "Set to true for double clicks. Default is false."
          },
          "button": {
            "type": "string",
            "enum": [
              "left",
              "right",
              "middle"
            ],
            "description": "Mouse button to click with. Default is \"left\"."
          }
        },
        "required": [
          "pageId",
          "element"
        ],
        "$comment": "One of \"ref\" or \"selector\" is required."
      },
      "tags": []
    },
    {
      "name": "drag_element",
      "description": "Drag an element over another element in a browser page.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID, acquired from context or the open tool."
          },
          "fromRef": {
            "type": "string",
            "description": "Element reference of the element to drag."
          },
          "fromSelector": {
            "type": "string",
            "description": "Playwright selector of the element to drag when \"fromRef\" is not available."
          },
          "fromElement": {
            "type": "string",
            "description": "Human-readable description of the element to drag (e.g., \"file item\", \"draggable card\")."
          },
          "toRef": {
            "type": "string",
            "description": "Element reference of the element to drop onto."
          },
          "toSelector": {
            "type": "string",
            "description": "Playwright selector of the element to drop onto when \"toRef\" is not available."
          },
          "toElement": {
            "type": "string",
            "description": "Human-readable description of the element to drop onto (e.g., \"drop zone\", \"target folder\")."
          }
        },
        "required": [
          "pageId",
          "fromElement",
          "toElement"
        ],
        "$comment": "One of \"fromRef\" or \"fromSelector\" is required, and one of \"toRef\" or \"toSelector\" is required."
      },
      "tags": []
    },
    {
      "name": "hover_element",
      "description": "Hover over an element in a browser page. Provide either a Playwright selector or an element reference.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID, acquired from context or the open tool."
          },
          "ref": {
            "type": "string",
            "description": "Element reference to hover over."
          },
          "selector": {
            "type": "string",
            "description": "Playwright selector of the element to hover over when \"ref\" is not available."
          },
          "element": {
            "type": "string",
            "description": "Human-readable description of the element to hover over (e.g., \"navigation menu\", \"tooltip trigger\")."
          }
        },
        "required": [
          "pageId",
          "element"
        ],
        "$comment": "One of \"ref\" or \"selector\" is required."
      },
      "tags": []
    },
    {
      "name": "type_in_page",
      "description": "Type text or press keys in a browser page.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID, acquired from context or the open tool."
          },
          "text": {
            "type": "string",
            "description": "The text to type. One of \"text\" or \"key\" must be provided."
          },
          "key": {
            "type": "string",
            "description": "A key or key combination to press (e.g., \"Enter\", \"Tab\", \"Control+c\"). One of \"text\" or \"key\" must be provided."
          },
          "ref": {
            "type": "string",
            "description": "Element reference to target. If omitted, types into the focused element."
          },
          "selector": {
            "type": "string",
            "description": "Playwright selector of element to target when \"ref\" is not available. If omitted, types into the focused element."
          },
          "element": {
            "type": "string",
            "description": "Human-readable description of the element to type into (e.g., \"search box\", \"comment field\"). Required when \"ref\" or \"selector\" is specified."
          }
        },
        "required": [
          "pageId"
        ],
        "$comment": "If \"ref\" or \"selector\" is provided, then \"element\" is required."
      },
      "tags": []
    },
    {
      "name": "run_playwright_code",
      "description": "Run a Playwright code snippet to control a browser page. Only use this if other browser tools are insufficient.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID, acquired from context or the open tool."
          },
          "code": {
            "type": "string",
            "description": "The Playwright code to execute. The code must be concise, serve one clear purpose, and be self-contained. You **must not** directly access `document` or `window` using this tool. You must access it via the provided `page` object, e.g. \"return page.evaluate(() => document.title)\". Omit this when resuming a deferred execution via deferredResultId."
          },
          "deferredResultId": {
            "type": "string",
            "description": "If a previous call returned a deferredResultId, pass it here to continue waiting for that execution to complete."
          },
          "timeoutMs": {
            "type": "number",
            "description": "Maximum time in milliseconds to wait for the code to complete. Defaults to 5000 (5 seconds)."
          }
        },
        "required": [
          "pageId"
        ],
        "$comment": "Either \"code\" or \"deferredResultId\" must be provided."
      },
      "tags": []
    },
    {
      "name": "handle_dialog",
      "description": "Respond to a pending modal (alert, confirm, prompt) or file chooser dialog on a browser page.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pageId": {
            "type": "string",
            "description": "The browser page ID, acquired from context or the open tool."
          },
          "acceptModal": {
            "type": "boolean",
            "description": "Whether to accept (true) or dismiss (false) a modal dialog."
          },
          "promptText": {
            "type": "string",
            "description": "Text to enter into a prompt dialog."
          },
          "selectFiles": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Absolute paths of files to select, or empty to dismiss. Required for file chooser dialogs."
          }
        },
        "required": [
          "pageId"
        ]
      },
      "tags": []
    },
    {
      "name": "vscode_askQuestions",
      "description": "Use this tool to ask the user a small number of clarifying questions before proceeding. Provide the questions array with concise headers and prompts. Use options for fixed choices, set multiSelect when multiple selections are allowed. Users can always provide a freeform text answer alongside options unless you set allowFreeformInput to false.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "questions": {
            "type": "array",
            "description": "List of questions to ask the user. Order is preserved.",
            "items": {
              "type": "object",
              "properties": {
                "header": {
                  "type": "string",
                  "description": "Short identifier for the question. Must be unique so answers can be mapped back to the question.",
                  "maxLength": 50
                },
                "question": {
                  "type": "string",
                  "description": "The question text to display to the user. Keep it concise, ideally one sentence.",
                  "maxLength": 200
                },
                "multiSelect": {
                  "type": "boolean",
                  "description": "Allow selecting multiple options when options are provided."
                },
                "allowFreeformInput": {
                  "type": "boolean",
                  "description": "Allow freeform text answers in addition to option selection. Defaults to true; set to false to restrict to predefined options only."
                },
                "message": {
                  "type": "string",
                  "description": "Optional markdown message to display below the question text, providing additional context or details."
                },
                "options": {
                  "type": "array",
                  "description": "Optional list of selectable answers. If omitted, the question is free text.",
                  "items": {
                    "type": "object",
                    "properties": {
                      "label": {
                        "type": "string",
                        "description": "Display label and value for the option."
                      },
                      "description": {
                        "type": "string",
                        "description": "Optional secondary text shown with the option."
                      },
                      "recommended": {
                        "type": "boolean",
                        "description": "Mark this option as the recommended default."
                      }
                    },
                    "required": [
                      "label"
                    ]
                  }
                }
              },
              "required": [
                "header",
                "question"
              ]
            },
            "minItems": 1
          }
        },
        "required": [
          "questions"
        ]
      },
      "tags": []
    },
    {
      "name": "vscode_reviewPlan",
      "description": "Use this tool to present a plan to the user for review. Provide the plan content as markdown, a list of approval actions (with optional default), and whether the user can provide freeform feedback. Optionally provide a URI to the backing plan file so the user can edit it. The tool returns the chosen action, whether the plan was rejected, and any feedback.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Title displayed in the widget header. Defaults to \"Review plan\" if omitted."
          },
          "plan": {
            "type": "string",
            "description": "Optional URI of an editable plan file. An Edit button in the widget header opens it in the editor."
          },
          "content": {
            "type": "string",
            "description": "Markdown content rendered in the body of the widget. May be the plan summary or full plan text."
          },
          "actions": {
            "type": "array",
            "description": "List of approval actions offered in the primary dropdown button. Order is preserved.",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string",
                  "description": "Short action label shown in the dropdown button."
                },
                "description": {
                  "type": "string",
                  "description": "Optional detail shown below the label in the dropdown list."
                },
                "default": {
                  "type": "boolean",
                  "description": "Whether this action should be selected by default."
                },
                "permissionLevel": {
                  "type": "string",
                  "enum": [
                    "autopilot"
                  ],
                  "description": "When set to \"autopilot\", a confirmation dialog is shown before proceeding."
                }
              },
              "required": [
                "label"
              ]
            },
            "minItems": 1
          },
          "canProvideFeedback": {
            "type": "boolean",
            "description": "When true, an additional feedback textarea is shown below the plan content."
          }
        },
        "required": [
          "content",
          "actions",
          "canProvideFeedback"
        ]
      },
      "tags": []
    },
    {
      "name": "manage_todo_list",
      "description": "Manage a structured todo list to track progress and plan tasks throughout your coding session. Use this tool VERY frequently to ensure task visibility and proper planning.\n\nWhen to use this tool:\n- Complex multi-step work requiring planning and tracking\n- When user provides multiple tasks or requests (numbered/comma-separated)\n- After receiving new instructions that require multiple steps\n- BEFORE starting work on any todo (mark as in-progress)\n- IMMEDIATELY after completing each todo (mark completed individually)\n- When breaking down larger tasks into smaller actionable steps\n- To give users visibility into your progress and planning\n\nWhen NOT to use:\n- Single, trivial tasks that can be completed in one step\n- Purely conversational/informational requests\n- When just reading files or performing simple searches\n\nCRITICAL workflow:\n1. Plan tasks by writing todo list with specific, actionable items\n2. Mark ONE todo as in-progress before starting work\n3. Complete the work for that specific todo\n4. Mark that todo as completed IMMEDIATELY\n5. Move to next todo and repeat\n\nTodo states:\n- not-started: Todo not yet begun\n- in-progress: Currently working (limit ONE at a time)\n- completed: Finished successfully\n\nIMPORTANT: Mark todos completed as soon as they are done. Do not batch completions.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "todoList": {
            "type": "array",
            "description": "Complete array of all todo items. Must include ALL items - both existing and new.",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "number",
                  "description": "Unique identifier for the todo. Use sequential numbers starting from 1."
                },
                "title": {
                  "type": "string",
                  "description": "Concise action-oriented todo label (3-7 words). Displayed in UI."
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "not-started",
                    "in-progress",
                    "completed"
                  ],
                  "description": "not-started: Not begun | in-progress: Currently working (max 1) | completed: Fully finished with no blockers"
                }
              },
              "required": [
                "id",
                "title",
                "status"
              ]
            }
          }
        },
        "required": [
          "todoList"
        ]
      },
      "tags": []
    },
    {
      "name": "vscode_get_confirmation",
      "description": "A tool that demonstrates different types of confirmations. Takes a title, message, and confirmation type (basic or terminal).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Title for the confirmation dialog"
          },
          "message": {
            "type": "string",
            "description": "Message to show in the confirmation dialog"
          },
          "confirmationType": {
            "type": "string",
            "enum": [
              "basic",
              "terminal"
            ],
            "description": "Type of confirmation to show - basic for simple confirmation, terminal for terminal command confirmation"
          },
          "terminalCommand": {
            "type": "string",
            "description": "Terminal command to show (only used when confirmationType is \"terminal\")"
          }
        },
        "required": [
          "title",
          "message",
          "confirmationType"
        ],
        "additionalProperties": false
      },
      "tags": []
    },
    {
      "name": "vscode_get_confirmation_with_options",
      "description": "A tool that demonstrates different types of confirmations. Takes a title, message, and buttons.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Title for the confirmation dialog"
          },
          "message": {
            "type": "string",
            "description": "Message to show in the confirmation dialog"
          },
          "buttons": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Custom button labels to display."
          }
        },
        "required": [
          "title",
          "message",
          "buttons"
        ],
        "additionalProperties": false
      },
      "tags": []
    },
    {
      "name": "vscode_get_modified_files_confirmation",
      "description": "A tool that shows a modified-files confirmation UI with a split primary button and a hardcoded cancel action.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Title for the confirmation dialog"
          },
          "message": {
            "type": "string",
            "description": "Message to show in the confirmation dialog"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "minItems": 1,
            "description": "Selectable option labels. The first option is used for the primary split button and the remaining options are placed in the dropdown menu."
          },
          "modifiedFiles": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "uri": {
                  "type": "string",
                  "description": "URI of the modified file."
                },
                "originalUri": {
                  "type": "string",
                  "description": "Optional original URI used when opening a diff."
                },
                "insertions": {
                  "type": "number",
                  "description": "Optional number of lines added."
                },
                "deletions": {
                  "type": "number",
                  "description": "Optional number of lines removed."
                },
                "title": {
                  "type": "string",
                  "description": "Optional title shown in the file tooltip."
                },
                "description": {
                  "type": "string",
                  "description": "Optional secondary label shown for the file entry."
                }
              },
              "required": [
                "uri"
              ],
              "additionalProperties": false
            },
            "description": "Modified files to show in the confirmation UI."
          }
        },
        "required": [
          "title",
          "message",
          "options",
          "modifiedFiles"
        ],
        "additionalProperties": false
      },
      "tags": []
    },
    {
      "name": "task_complete",
      "description": "Signal that the user's task is fully done. You MUST call this tool when your work is complete — whether you made code changes, answered a question, or completed any other kind of task. Provide a brief summary of what was accomplished. Do not restate the summary in your message text — it is shown to the user directly.\n\nIMPORTANT: Before calling this tool, you MUST output a brief text message summarizing what was done. The task is not complete until both your summary message AND this tool call are present.\n\nWhen to call:\n- After answering the user's question or completing a conversational request\n- After you have completed ALL requested changes\n- After verifying results: tests pass, terminal commands succeeded, tool calls returned expected output\n\nWhen NOT to call:\n- If a terminal command failed or produced unexpected output\n- If an MCP or external tool call returned an error\n- If you encountered errors you have not resolved\n- If there are remaining steps to complete\n- If you have not verified your changes work",
      "inputSchema": {
        "type": "object",
        "properties": {
          "summary": {
            "type": "string",
            "description": "Brief summary of what was accomplished. Omit for trivial interactions."
          }
        }
      },
      "tags": []
    },
    {
      "name": "runSubagent",
      "description": "Launch a new agent to handle complex, multi-step tasks autonomously. This tool is good at researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries, use this agent to perform the search for you.\n\n- Agents do not run async or in the background, you will wait for the agent's result.\n- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n- Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n- The agent's outputs should generally be trusted\n- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n- If the user asks for a certain agent, you MUST provide that EXACT agent name (case-sensitive) to invoke that specific agent.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "prompt": {
            "type": "string",
            "description": "A detailed description of the task for the agent to perform"
          },
          "description": {
            "type": "string",
            "description": "A short (3-5 word) description of the task"
          },
          "agentName": {
            "type": "string",
            "description": "Optional name of a specific agent to invoke. If not provided, uses the current agent."
          },
          "model": {
            "type": "string",
            "description": "Optional model for the subagent. Format: \"Model Name (Vendor)\", vendor is usually \"copilot\". Only use to enforce a specific model."
          }
        },
        "required": [
          "prompt",
          "description"
        ]
      },
      "tags": []
    },
    {
      "name": "runTests",
      "description": "Runs unit tests in files. Use this tool if the user asks to run tests or when you want to validate changes using unit tests, and prefer using this tool instead of the terminal tool. When possible, always try to provide `files` paths containing the relevant unit tests in order to avoid unnecessarily long test runs. This tool outputs detailed information about the results of the test run. Set mode=\"coverage\" to also collect coverage and optionally provide coverageFiles for focused reporting.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "files": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Absolute paths to the test files to run. If not provided, all test files will be run."
          },
          "testNames": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "An array of test names to run. Depending on the context, test names defined in code may be strings or the names of functions or classes containing the test cases. If not provided, all tests in the files will be run."
          },
          "mode": {
            "type": "string",
            "enum": [
              "run",
              "coverage"
            ],
            "description": "Execution mode: \"run\" (default) runs tests normally, \"coverage\" collects coverage."
          },
          "coverageFiles": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "When mode=\"coverage\": absolute file paths to include detailed coverage info for. If not provided, a file-level summary of all files with incomplete coverage is shown."
          }
        }
      },
      "tags": [
        "vscode_editing_with_tests",
        "enable_other_tool_copilot_readFile",
        "enable_other_tool_copilot_listDirectory",
        "enable_other_tool_copilot_findFiles",
        "enable_other_tool_copilot_runTests",
        "enable_other_tool_copilot_runTestsWithCoverage",
        "enable_other_tool_testFailure"
      ]
    },
    {
      "name": "testFailure",
      "description": "Includes test failure information in the prompt. Use this tool to get the details of test failures from the most recent test run. If there are no failures yet, suggest running tests first.",
      "inputSchema": {
        "type": "object",
        "properties": {}
      },
      "tags": [
        "vscode_editing_with_tests",
        "enable_other_tool_copilot_readFile",
        "enable_other_tool_copilot_listDirectory",
        "enable_other_tool_copilot_findFiles",
        "enable_other_tool_copilot_runTests"
      ]
    },
    {
      "name": "tool_search",
      "description": "Search for relevant tools by describing what you need. Returns tool references for tools matching your query. Use this when you need to find a tool but aren't sure of its exact name. Check the availableDeferredTools list in your instructions for the full set of deferred tools, and include relevant tool names from that list in your query for more accurate results. Use broad queries to find all related tools in a single call rather than making multiple narrow searches.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Natural language description of what tool capability you are looking for. Use broad queries to cover related tools in one search (e.g., \"github\" instead of separate searches for issues and PRs)."
          }
        },
        "required": [
          "query"
        ]
      },
      "tags": []
    }
  ]
}