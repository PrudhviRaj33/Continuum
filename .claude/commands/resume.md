I just resumed after a context compaction or new session start.

1. Call `get_session` to recover current task state, goal, and decisions.
2. Call `get_touched_files` to see what files were already modified this session.
3. Continue the task from where we left off — do NOT ask me to re-explain the goal.

If `latest_task` is null, ask me what we were working on.
