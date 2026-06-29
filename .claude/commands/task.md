Starting a new task: $ARGUMENTS

1. Call `search_symbols` with relevant keywords from the task to find existing code.
2. Call `find_related_files` to locate files across all layers (controller/service/repo/UI/test).
3. Call `get_touched_files` to see what was already changed this session.
4. If the task involves database tables, call `get_schema` for each relevant table.

Then plan the implementation in detail before writing any code.
