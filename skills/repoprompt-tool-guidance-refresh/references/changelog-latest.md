##### 2.1.0 - April 2, 2026

New Features

-   MCP-controlled agents and sub-agents — start and steer Agent Mode sessions from external MCP clients or the CLI, with cross-family sub-agent support (Claude can steer Codex, Codex can steer Claude)
-   Agent role defaults — configure default models per agent role (explore, engineer, pair, design) with per-role override controls

Improvements

-   Faster window restore — consolidated session data loading for less main-thread blocking
-   Cleaner MCP API — dedicated manage_selection and prompt tools replace context_state; chat tools renamed to oracle for consistency
-   New context_bind tool — easier workspace binding via working directories
-   Cmd+W now stashes compose tabs instead of closing them

Fixes

-   Improved app stability — fixed crashes on deeply nested directory trees
-   Fixed memory retention issues for large repositories
-   Fixed file_search hanging on regex patterns with .* or .+ quantifiers
-   Fixed detached transcript jump-to-top restore
