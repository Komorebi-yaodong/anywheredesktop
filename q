[33mcommit 12f27abde6cdef894b11d9ee851651ce59577b11[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m, [m[1;31morigin/main[m[33m)[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon Jun 22 23:57:31 2026 +0800

    fix: limit grep output and tokenized chat naming

[33mcommit fe25625ec1d474ea17a164e6feff92e18f9b9263[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sun Jun 21 04:00:56 2026 +0800

    fix: cancel assistant requests immediately

[33mcommit c9b5c2ff3120c81d6916c5e8b069a515658f9dda[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sun Jun 21 03:16:09 2026 +0800

    fix: stabilize task panel position and strip mcp ansi output

[33mcommit 6121932fd051e5dba13e7d4673550cef87c0b8a6[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sun Jun 21 01:17:06 2026 +0800

    feat: focus custom input and use ctrl+enter for newline in choice card

[33mcommit 1adb51210a3fcb1663068fee8c858299c288f29a[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sun Jun 21 00:05:40 2026 +0800

    feat: pass selected folder path as text input

[33mcommit 0ec9da83d2e7923d338f36b19729e10c5e8d6d43[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 23:01:51 2026 +0800

    fix: anchor task panel to top-right below header and left of nav
    
    default position clears the chat header (using .chat-main top) and the
    right-side nav sidebar instead of overlapping them

[33mcommit 23cce8eff23cdcad120421c0d5b60eff09be6911[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 22:54:55 2026 +0800

    fix: default task panel to top-left and submit choice input on enter
    
    - task panel now opens at the top-left (below the system-prompt header,
      left of the right-side nav column) instead of covering the header
    - Enter in the choice free-text input advances to the next question or
      submits; Shift+Enter inserts a newline

[33mcommit 9995eb28055e901a4e8bd7e0cf5a1084a65bafd4[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 22:47:26 2026 +0800

    feat: persist task list in session, use check icon for done state
    
    - the task list is saved into the session JSON and restored on reopen
      (loadSession no longer wipes it; clearHistory still clears it)
    - header completed badge shows a green check icon instead of a green dot

[33mcommit 043cb08dc27793d58e9e41323aa0c4188500c77c[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 21:43:29 2026 +0800

    feat: task status badge and read-before-write guidance
    
    - header task button now shows overall status (gray pending / spinner
      in-progress / green completed) instead of a count badge that rendered
      as a static white dot
    - task_write/task_read descriptions instruct the model to read before
      writing and to update progress right after finishing each task or step

[33mcommit 1cbfa025ce8488759e2a59b31927a3ebe7890764[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 21:32:37 2026 +0800

    style: simplify task panel status indicators
    
    Drop the bordered-circle status dots in favor of color/icon only: a green
    check for completed, a spinner for in_progress, and a gray dot for pending.

[33mcommit 036efd1e6838486b01cd8870f7c545f67f0ee496[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 21:23:02 2026 +0800

    fix: refine choice/task UI and add task_read
    
    - ChoiceCard: single-select only (drop multiSelect); the selected option
      letter stays visible in dark mode (primary ring, not a filled badge)
    - TaskPanel: center the loading/check icons within their status circles
    - add a task_read tool so the model can re-read the current task list and
      recover progress after a long conversation or context compaction

[33mcommit 147da58e790aa43f847a3d718bef3000c9230941[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 21:07:21 2026 +0800

    refactor: polish Better Work UI and buffer behavior
    
    - task panel: more translucent, Ctrl+T toggles it, status icons centered
    - buffered messages also flush right after a tool call completes (drained
      into history mid tool-loop); buffer strip is now translucent
    - ChoiceCard: one question at a time with prev/next paging; fix dark-mode
      selected styling so option letters stay visible
    - AI-facing tool results and fallbacks switched to English

[33mcommit 8fb3f83771d107b0b0c07a6473d38fa65faf8fb2[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 20:27:39 2026 +0800

    fix: do not buffer sends during MCP tool loading
    
    isMcpLoading has no loading cycle to trigger a flush, so a message queued
    during it would stay stuck in the buffer. Only buffer on loading /
    isPreparingSend; askAI keeps its existing "tools loading" notice.

[33mcommit 621a3beb96ba82351c637e9694b775546c36d111[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 20:23:34 2026 +0800

    feat: buffer messages sent during loading and follow-up
    
    - messages sent while a request or MCP run is in progress now go to a
      buffer shown above the upload area, and can be cancelled before sending
    - buffered messages auto-append as separate user messages and continue
      the request once the current turn finishes
    - global follow-up while loading buffers instead of aborting the in-flight
      request (extracted appendCurrentInputToHistory; deferSend folds files)

[33mcommit 7ef1081d2dbd9f04bd00dd6a43ad7923dd328e31[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 20:11:37 2026 +0800

    feat: add Better Work MCP for choices and task panel
    
    - ask_user_choice: in-bubble multi-question/multi-option confirmation,
      with a custom free-text input and a "discuss this" option per question
    - task_write: temporary per-conversation task list rendered in a
      draggable translucent task panel
    - header task button replaces the search button (shown only when the
      task tool is active); content search moves to Ctrl+F

[33mcommit 2d3e8226a34ee25f09c993817174cc7b4c855ae7[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 18:48:57 2026 +0800

    feat: harden builtin file edit tools
    
    - edit_file echoes the changed section with line numbers
    - auto-strip mistaken "NNNN | " line-number prefixes from old_string and retry
    - richer not-found diagnostics (line-number/whitespace hints + closest line)
    - remind write tools (write_file/replace_pattern/insert_content) to read_file first

[33mcommit 6d396e3ec669e48f46e58e11a3630f9a9d827bf5[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 18:24:40 2026 +0800

    style: center delete-project dialog and align header/body padding
    
    Add align-center so the dialog sits in the viewport middle, and use a
    global style block to give the dialog header/body/footer consistent
    horizontal padding so the title and message line up with extra spacing
    between them.

[33mcommit 87c35f90a5a49d4e359bf62deff93f381c7861cf[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 18:17:18 2026 +0800

    feat: sync project assignments to cloud and polish delete dialog
    
    Force-sync a chat now also syncs its project assignment to the other
    side's projects.yaml; project headers gain a whole-project sync button;
    smart upload/download merge assignments in one pass. Redesign the delete
    dialog as stacked option cards and fix the window project dropdown being
    clipped by switching it back to a teleported popper.

[33mcommit 81529f8549dbf54b4daef3f2ab2e3f069a8d2249[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 17:46:41 2026 +0800

    feat: custom pointer drag for chats and 3-option project delete
    
    Replace native HTML5 drag with a pointer-based drag so the wheel scrolls
    during a drag and chats can be dropped back to Ungrouped reliably
    (elementFromPoint hit-testing). Delete-project now offers three choices:
    delete with chats, keep chats (move to Ungrouped), or cancel.

[33mcommit 18b84e235ca5b0f63f893a0cae12b93c9944836f[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 17:22:28 2026 +0800

    feat: batch drag chats and auto-scroll while dragging
    
    Show a count badge when dragging multiple selected chats into a project,
    and auto-scroll the list when the cursor nears the top/bottom edge during
    a drag (native DnD suppresses wheel events), so chats can reach the
    topmost project even when it is off-screen.

[33mcommit 0206e7f14db7b69599cf2b961718cf4435a23e55[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 17:05:41 2026 +0800

    feat: choose project when saving or renaming a chat
    
    Add a project selector to the save-as-json, save-to-cloud, and rename
    dialogs in the chat window. Saving updates the matching projects.yaml
    (local or cloud) so the chat lands in the chosen project; renaming can
    move name and project together or just reassign the project.

[33mcommit a141229ec4c48a36634bbfdf6c5e629076d5503b[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 06:08:08 2026 +0800

    feat: drag chats into projects and fix basename matching
    
    Name-area drag assigns chats to a project (or ungrouped) via HTML5 DnD
    while the time/size area keeps box-selection. Tolerate project file
    entries written without the .json suffix so manual yaml edits group too.

[33mcommit ad9e4d60960b47e482db816cbc566e6aabcce832[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 05:05:58 2026 +0800

    feat: group chat history by projects with collapse and management
    
    Render projects from projects.yaml above ungrouped chats (alpha-sorted,
    collapsible, per-mode sorted); add create/rename/delete project actions
    writing back to the active view's yaml. Box-selection now keys off
    data-basename to support grouped rows.

[33mcommit b79b61dd51b7d0e9638f91ec9dc56c1cf02adca8[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 04:41:57 2026 +0800

    feat: add projects.yaml backend for chat history grouping
    
    Add js-yaml-based projects.js with local/cloud read-write, single-owner
    normalization, and assignment merge helpers; wire IPC and preload bridges.

[33mcommit d152078cff7e1c51b1cafb6197fb2cd472439abd[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 03:48:08 2026 +0800

    fix: handle claude base URL and model listing for anthropic protocol

[33mcommit 059f4731fc2c8e38d115e763936a3b216d3f33f2[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 03:25:45 2026 +0800

    fix: add session_id and prompt_cache_key for codex requests

[33mcommit 6f457a4a4d76f13f40cc1afb98bb6c1a18b3d442[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 02:19:23 2026 +0800

    fix: align codex request body with CPA (empty instructions, keep input developer)

[33mcommit b195cc4fa64466c5cf5fe963b6ee26753c646693[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 01:56:29 2026 +0800

    fix: add type:message to responses/codex input items

[33mcommit 8a20c739a8468ab12f0e4d35af76ac06d844f0eb[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 01:47:51 2026 +0800

    fix: lift codex system prompt to instructions

[33mcommit 2695c86d47043eacfd63dca4427685f9a57edc7a[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 01:44:31 2026 +0800

    feat: add claude API protocol via Anthropic SDK

[33mcommit 08f9bcd162defae13efbb178b042a01ad30060bc[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 01:37:33 2026 +0800

    feat: add codex API protocol type

[33mcommit f0e8307189708e77972b396c891088284ad5c2ef[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 00:57:20 2026 +0800

    style: move add-header button beside label

[33mcommit 58ce0310dd5fa98a5c9fc0c777a6afb6a0315f29[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 00:57:20 2026 +0800

    fix: make custom User-Agent effective via header bridge

[33mcommit 4ad3f48bb1450c48a88549860e406f8cb8de05f8[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 00:23:30 2026 +0800

    feat: configure provider headers in settings UI

[33mcommit 02b4548c3402e365e8a36573e3cb42cead30f09d[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat Jun 20 00:06:52 2026 +0800

    feat: forward provider headers across request callers

[33mcommit 8f0ac837a432f071dfce3848c009bb475b05705f[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 23:57:45 2026 +0800

    feat: add provider headers field with config migration

[33mcommit 036b155629f0dffe084e85436934214f855d7ffa[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 23:54:42 2026 +0800

    feat: support custom headers in chat requests

[33mcommit bb7bbc34148da021cef848a628c128fe2ba7d856[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 19:03:53 2026 +0800

    style: polish screenshot editor toolbar

[33mcommit 8dca9f0028013600aaad66d594aaa0b8b7c37ea0[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 17:58:52 2026 +0800

    perf: speed up screenshot capture startup

[33mcommit f28361e3f2b3e84c5c333470f6548f273e579d1d[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 17:46:48 2026 +0800

    perf: preheat screenshot window

[33mcommit 55e2e4c8bfb8812cd648b1f69c4e069b80fd4077[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 17:38:22 2026 +0800

    fix: hide quick before screenshot capture

[33mcommit 42adba76b00e064591723f0256749207ff99bd17[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 16:26:50 2026 +0800

    feat: open chat history from context menu

[33mcommit 688387165f3c0408d67ceb9f8780be7f665c9548[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 15:57:24 2026 +0800

    update README

[33mcommit ee6b52be3ef729bf5c48ff14a7bba339d5a9cbff[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 15:51:48 2026 +0800

    feat: add screenshot annotation tools

[33mcommit aeaa38a96cb6e691c631717e5b4412c1c5f700b1[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 15:48:14 2026 +0800

    feat: route image helpers through screenshot capture

[33mcommit 52d657f5a4be3f3b23832191673669a2e47f750f[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri Jun 19 15:06:31 2026 +0800

    fix: align mac tray and quick window chrome

[33mcommit d04208e441adaf791423b19a5daab515fcc88608[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Wed Jun 10 02:58:24 2026 +0800

    add dependency

[33mcommit 6b0fb276812d9e5e8a7388b2d55313c4d5872efb[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Wed Jun 10 02:23:43 2026 +0800

    fix: bundle markitdown-js for electron packaging

[33mcommit fd86eb56fb44c13a9770b93580fe9c2a764a4f89[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Wed Jun 10 01:41:16 2026 +0800

    add mime-db

[33mcommit 8577d5514bdf00b91d3de4d2a272816aa658ed50[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue Jun 9 23:54:27 2026 +0800

    fix: resolve markitdown-js constructor export

[33mcommit ac5fe47be38d86618f7662ec340cc76f3b23d065[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue Jun 9 23:40:41 2026 +0800

    feat: use markitdown-js for web fetch markdown

[33mcommit e7bcfa6dc0438e91040987bc1e9c2bb645e73e80[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue Jun 9 23:11:59 2026 +0800

    docs: benchmark markitdown-js fetch conversion

[33mcommit f77af8528a25a87bae51df5b867c9765a0d926e6[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue Jun 9 11:17:11 2026 +0800

    fix: restore nested markdown placeholders

[33mcommit 1888ed6f7cbebfe2d28247896916225180060126[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu Jun 4 21:12:46 2026 +0800

    feat: show reasoning token usage

[33mcommit 2f19239e1e16ca736bcc4725e4e0c6da5a26647b[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu Jun 4 20:51:50 2026 +0800

    更新token统计功能的表述

[33mcommit d1ac3e4e0079fec8138c70be5aeec787f4eb99f0[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu Jun 4 20:37:05 2026 +0800

    feat: show assistant token usage

[33mcommit 387e32883241be8c3f692fe30f32268419845e00[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu Jun 4 19:57:09 2026 +0800

    调整工具窗口上下文限制

[33mcommit 165822a658d2093884b2430e1fd563607374ce2f[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue Jun 2 15:30:13 2026 +0800

    update skill prompt

[33mcommit 58ebc96666cf8b466128da6b4035c3b69560d318[m[33m ([m[1;33mtag: [m[1;33mv1.1.14[m[33m)[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat May 30 20:57:28 2026 +0800

    1.1.14

[33mcommit 5fab2e8dc0b4d9b5cf5f80476445e7bea58b88f8[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat May 30 19:15:12 2026 +0800

    docs: analyze chat history loading performance

[33mcommit 0a9b080335a07dad0a1d8e9dc5229c8026ecada5[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sat May 30 16:58:57 2026 +0800

    feat: open skill folder from manager

[33mcommit a4c3b7de1d821e0902c731669d81454525bb4a67[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 25 21:29:44 2026 +0800

    fix: align rename dialog description

[33mcommit 9729b0962b7d9957c03fa5505ec13aa9f5670149[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 25 20:23:02 2026 +0800

    fix: unify summon session naming

[33mcommit 2da0545036cbfb5d261b185d84ccb5974b90affe[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 25 19:57:59 2026 +0800

    feat: support route selection for default summon agent

[33mcommit a1d7c48e4d7d24f0965ffb0c7e0c6f7049316a91[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 25 00:23:12 2026 +0800

    fix: set linux executable name explicitly

[33mcommit e2ace1f6a7d005f795ddc6dc007cfbf6c24e3490[m[33m ([m[1;33mtag: [m[1;33mv1.1.13[m[33m)[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 25 00:06:45 2026 +0800

    1.1.13

[33mcommit 5944a14ce0437dfdfa997a4b283a163d89d08587[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Sun May 24 23:31:20 2026 +0800

    fix: auto save named chat sessions

[33mcommit 3445cd038267befc801c3c5a6bc174a6a598c090[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri May 22 19:03:55 2026 +0800

    style: align auto naming button in save dialogs

[33mcommit 29a23b3a704dd710c035c0a584228c89606a1a95[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Fri May 22 18:10:37 2026 +0800

    feat: add manual fast-model chat naming

[33mcommit dfff37f7778feac0c03bfe73790145056996cf6e[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 12:35:49 2026 +0800

    fix: restore system theme follow behavior

[33mcommit e0231d15fe7ba3a68cd449a3602e67142b7e29b0[m[33m ([m[1;33mtag: [m[1;33mv1.1.12[m[33m)[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 11:35:18 2026 +0800

    1.1.12

[33mcommit c44446c04d3715d4e3b3e1fb31a1bb0c78fd92d9[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 04:23:08 2026 +0800

    refactor: remove debug log wrappers

[33mcommit 1ef6fcc5182b5d9fc0956e8a2a1d2958b139a4b8[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 03:58:05 2026 +0800

    fix: decode remote image buffer for clipboard copy

[33mcommit 8efce3c3ee58051b917907c864323d9b28bf18d0[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 03:35:00 2026 +0800

    fix: improve window image copy and export

[33mcommit 36337a62b81769b563b2c6d72d4d3540ad73ecaf[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 02:51:14 2026 +0800

    chore: remove leftover theme debug log

[33mcommit 450d370da3922f1a74c00dfb5763f872550b4899[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 02:43:46 2026 +0800

    fix: auto save window session after auto naming

[33mcommit 48351399a444a336ea99d46660dab6316e603156[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 02:34:08 2026 +0800

    fix: allow splash startup script under CSP

[33mcommit 2bcda1cbd4a8d4481bde3045febc4ceee48e4e07[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 02:27:30 2026 +0800

    debug: trace splash theme startup flow

[33mcommit 0d568a9443b8edd4da87f4ed5c72bdf91db73355[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 02:18:51 2026 +0800

    fix: align splash theme with configured mode

[33mcommit 4537be386c5fbdec9839370b512123e6c8917324[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 02:01:01 2026 +0800

    fix: keep splash theme aligned with startup dark mode

[33mcommit 90888d9dc64943d58bc027aab1bc66d2c003a56d[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 01:55:16 2026 +0800

    feat: add startup splash for main window

[33mcommit 7332ab9329746ab8315bdef496f5dad6aa2350d5[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Thu May 21 00:25:49 2026 +0800

    feat(window): optimize thinking panel style and collapse action

[33mcommit b1417c3d3562db2a03cd9014d782fe8fd7fd2b77[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Wed May 20 23:47:44 2026 +0800

    fix: eliminate dark mode startup flash

[33mcommit 077ba8d458f65f033d0170314049fe51452baa3b[m[33m ([m[1;31mgitee/main[m[33m)[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Wed May 20 21:45:56 2026 +0800

    fix: allow html preview iframe in window markdown

[33mcommit 763434ae3451f847c530dd26968cd0bd80f1545d[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Wed May 20 11:05:18 2026 +0800

    fix: respect window auto save setting for naming

[33mcommit 4ba541ae054190d2df777ea1afb844279be9f6bf[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 22:04:04 2026 +0800

    1.1.11

[33mcommit 6aab79b30b27dac036aa9d44b63656e8bf7848e2[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 21:25:22 2026 +0800

    fix: stabilize window cancel action during requests

[33mcommit de4d3c75e8cc01847ecb0a0684622010088b32ff[m[33m ([m[1;33mtag: [m[1;33mv1.1.10[m[33m)[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 20:45:33 2026 +0800

    1.1.10

[33mcommit 714bdccccdda7a4f98e5f6634d1bd77671d30c7c[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 18:04:44 2026 +0800

    feat: allow saving chat during active response

[33mcommit 405a86b840a216491f846838fbfb819916868dc0[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 17:56:06 2026 +0800

    fix: sync auto naming with first message cancel

[33mcommit 9d1285e3d05f72f053d6a24769ff2106104cdb47[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 17:36:19 2026 +0800

    refactor: simplify auto chat naming filenames

[33mcommit eac3ffcf71d0ed051c87267788ae4269dde49614[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 17:30:15 2026 +0800

    refactor: refine auto naming payload context

[33mcommit e11794824918d83e973788c825f4c06dafed0339[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 17:24:25 2026 +0800

    feat: add fast route tip for auto naming

[33mcommit a4e1f2a648ba2943ca591afae34c5154a7e9bbd5[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Tue May 19 17:22:30 2026 +0800

    feat: use fast route model for auto naming

[33mcommit 33ddd1c2046570f5bd4d0fd1e795247a6b88f1c8[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 18 17:55:29 2026 +0800

    style: polish window nav sidebar visuals

[33mcommit 2fce09476aa1f6d8166b61e5654131c082a1fa2e[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 18 17:36:07 2026 +0800

    style: distinguish user and ai nav markers

[33mcommit ef7ffed35db09e415e0651e4a56ecabc26d6311f[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 18 17:27:40 2026 +0800

    style: tighten window nav timeline

[33mcommit d9091c24e0b2eb787b78dd7f4a0d32a194b5c9e1[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 18 17:19:47 2026 +0800

    feat: refine window mcp prompt and nav style

[33mcommit 7aa58ace77c11afaac3113d7fc1176d6b83bcab7[m
Author: Komorebi-yaodong <1693324937@qq.com>
Date:   Mon May 18 17:0