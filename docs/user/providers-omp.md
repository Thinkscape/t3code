# OMP

T3 Code connects directly to the Oh My Pi (`omp`) native RPC interface. Install OMP 18.16.0 or newer on the machine running your T3 server, configure its model provider there, then enable **OMP** in Settings. If `omp` is not on that server's PATH, set its binary path.

OMP keeps its configured models, authentication, project context, extensions, and skills. The model picker uses OMP's discovered models and thinking levels. Workspace slash commands and skills appear in the composer. Terminal-only widgets and editors that require a custom terminal renderer are not displayed.

Assistant text, reasoning, tool output, compaction, usage, and native subagent progress appear in the conversation. You can stop or steer a running turn and queue subsequent messages. A yielded model response remains active while OMP reports pending asynchronous work. OMP confirmation, selection, text-input, editor, and structured question dialogs appear in T3 Code; pending dialogs do not survive a process restart.

Supervised mode asks before commands and changes. Auto-accept edits allows the built-in edit and write tools; Full access runs without T3 confirmations. T3 launches OMP with the matching `--approval-mode`, so which calls ask is OMP's decision; changing the mode restarts the OMP process and resumes its session. Subagents run under the parent's `task` approval and never ask separately.

T3 does not list native OMP sessions for import: official T3 clients reject agent-session sources they do not know. Resuming a T3 thread uses a private copy of its OMP session under T3's state directory. Native conversation forks and rollback use OMP's session tree. Project paths must exist on the server that owns the provider.

Provider settings show version advisories and an update action when the installation supports it. Native installations use `omp update`; package-managed installations use their owning manager. Updates run separately from existing agent processes and refresh provider metadata afterward. Existing processes retain the version they started with; start a new session to use the updated binary. T3 does not automatically update OMP, change its release channel, or update plugins.

T3's MCP tools are available to the agent, including through eval and subagents. Native OMP subagents appear as subagents with read-only child threads that stream their text, reasoning and tool calls. The **Plan** mode option launches OMP in its headless plan flow and shows the submitted plan in T3's plan card; approving it returns the thread to the default mode. OMP's todo tool feeds T3's todo list, and its usage limits feed T3's limit bars. Terminal UI themes, widgets, live voice, and terminal input shortcuts remain terminal features.
