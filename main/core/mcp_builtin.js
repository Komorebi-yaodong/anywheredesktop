const BUILTIN_SERVERS = {
  builtin_python: {
    id: 'builtin_python',
    name: 'Python Executor',
    description: '自动检测环境，执行本地 Python 脚本。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['python', 'code'],
    logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/c3/Python-logo-notext.svg'
  },
  builtin_filesystem: {
    id: 'builtin_filesystem',
    name: 'File Operations',
    description: '全能文件操作工具。支持文件读写、搜索、编辑与路径处理。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['file', 'fs', 'read', 'write', 'edit', 'search'],
    logoUrl: 'https://cdn-icons-png.flaticon.com/512/2965/2965335.png'
  },
  builtin_bash: {
    id: 'builtin_bash',
    name: 'Shell Executor',
    description: '执行 PowerShell 命令。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['shell', 'powershell', 'cmd'],
    logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/4b/Bash_Logo_Colored.svg'
  },
  builtin_search: {
    id: 'builtin_search',
    name: 'Web Toolkit',
    description: '联网搜索与网页抓取工具。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['search', 'web', 'fetch'],
    logoUrl: 'https://upload.wikimedia.org/wikipedia/en/9/90/The_DuckDuckGo_Duck.png'
  },
  builtin_superagent: {
    id: 'builtin_superagent',
    name: 'Super-Agent',
    description: '多智能体编排与代理调度中心。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['agent', 'orchestration'],
    logoUrl: 'https://s2.loli.net/2026/01/22/tTsJjkpiOYAeGdy.png'
  },
  builtin_tasks: {
    id: 'builtin_tasks',
    name: 'Task Manager',
    description: '管理 Anywhere 的定时任务。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['task', 'schedule', 'cron'],
    logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/4a/Commons-logo.svg'
  },
  builtin_time: {
    id: 'builtin_time',
    name: 'Time Service',
    description: '获取当前系统时间或指定时区时间。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['time', 'clock'],
    logoUrl: 'https://api.iconify.design/lucide:clock.svg'
  },
  builtin_memory: {
    id: 'builtin_memory',
    name: 'Memory System',
    description: '本地持久化记忆系统。',
    type: 'builtin',
    isActive: true,
    isPersistent: false,
    tags: ['memory', 'storage', 'sync'],
    logoUrl: 'https://api.iconify.design/lucide:brain.svg'
  }
}

const BUILTIN_TOOLS = {
  builtin_python: [
    {
      name: 'list_python_interpreters',
      description: 'Scan the system for available Python interpreters (Path & Conda).',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'run_python_code',
      description: 'Execute Python code. Writes code to a temporary file and runs it.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The Python code to execute.' },
          interpreter: { type: 'string', description: 'Optional. Path to specific python executable.' }
        },
        required: ['code']
      }
    },
    {
      name: 'run_python_file',
      description: 'Execute a local Python script file. Supports setting working directory and arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the .py file.' },
          working_directory: { type: 'string', description: 'Optional. The directory to execute the script in.' },
          interpreter: { type: 'string', description: 'Optional. Path to specific python executable.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional. Command line arguments.' }
        },
        required: ['file_path']
      }
    }
  ],
  builtin_filesystem: [
    {
      name: 'glob_files',
      description: 'Fast file pattern matching to locate file paths.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' }
        },
        required: ['pattern', 'path']
      }
    },
    {
      name: 'grep_search',
      description: 'Search for patterns in file contents using Regex.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
          multiline: { type: 'boolean' }
        },
        required: ['pattern', 'path']
      }
    },
    {
      name: 'read_file',
      description: 'Read content from a local file path or remote URL.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'integer' },
          length: { type: 'integer' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          show_line_numbers: { type: 'boolean' }
        },
        required: ['file_path']
      }
    },
    {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }
  ],
  builtin_bash: [
    {
      name: 'execute_bash_command',
      description: 'Execute a shell command in PowerShell on Windows.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          background: { type: 'boolean' },
          timeout: { type: 'integer' }
        },
        required: ['command']
      }
    },
    {
      name: 'list_background_shells',
      description: 'List running background shell sessions.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'read_background_shell_output',
      description: 'Read stdout/stderr from a background shell session.',
      inputSchema: {
        type: 'object',
        properties: {
          shell_id: { type: 'string' },
          offset: { type: 'integer' },
          length: { type: 'integer' }
        },
        required: ['shell_id']
      }
    },
    {
      name: 'kill_background_shell',
      description: 'Terminate a background shell process.',
      inputSchema: {
        type: 'object',
        properties: { shell_id: { type: 'string' } },
        required: ['shell_id']
      }
    }
  ],
  builtin_search: [
    {
      name: 'web_search',
      description: 'Search the internet for a given query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'integer' },
          language: { type: 'string' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_fetch',
      description: 'Retrieve and parse the full text content of a specific URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          offset: { type: 'integer' },
          length: { type: 'integer' }
        },
        required: ['url']
      }
    }
  ],
  builtin_superagent: [
    {
      name: 'sub_agent',
      description: 'Delegates a specific sub-task to a temporary background AI worker.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          context: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } }
        },
        required: ['task', 'tools']
      }
    },
    {
      name: 'list_agents',
      description: 'List all pre-configured professional Agents.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: { type: 'string' }
        }
      }
    },
    {
      name: 'summon_agent',
      description: 'Summon a professional Agent window and pass initial task context.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_name: { type: 'string' },
          task: { type: 'string' },
          context: { type: 'string' }
        },
        required: ['agent_name', 'task']
      }
    }
  ],
  builtin_tasks: [
    {
      name: 'list_tasks',
      description: 'List scheduled tasks.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'run_task',
      description: 'Run a scheduled task immediately.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id']
      }
    }
  ],
  builtin_time: [
    {
      name: 'get_current_time',
      description: 'Get current local system time.',
      inputSchema: { type: 'object', properties: {} }
    }
  ],
  builtin_memory: [
    {
      name: 'create_memory',
      description: 'Create a new structured memory document.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['name']
      }
    },
    {
      name: 'list_memories',
      description: 'List all available memory documents.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

export function getBuiltinServers() {
  return clonePlain(BUILTIN_SERVERS) || {}
}

export function getBuiltinTools(serverId = '') {
  return clonePlain(BUILTIN_TOOLS[serverId] || []) || []
}

export async function invokeBuiltinTool(toolName, _toolArgs = {}, _signal = null, _context = null) {
  if (toolName === 'get_current_time') {
    return JSON.stringify(
      [
        {
          type: 'text',
          text: new Date().toLocaleString('zh-CN', { hour12: false })
        }
      ],
      null,
      2
    )
  }

  throw new Error(`[mcp_builtin] builtin tool "${toolName}" is not registered in desktop runtime`)
}

export async function handleBgShellRequest(action, _payload) {
  throw new Error(`[mcp_builtin] background shell action "${action}" is not supported in desktop runtime yet`)
}

export function killAllBackgroundShells() {
  return {
    ok: true,
    killed: 0
  }
}
