While you work, run only the tests near your change: {{focused}}. Save the
whole suite for the end.

{{final}}

A whole suite can print thousands of lines. Keep what you read to its failures
and its tail (`… 2>&1 | tail -n 80`). Give a slow one a Bash timeout long
enough to finish, up to ten minutes, rather than letting it be cut off.
