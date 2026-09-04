# Codex App host contract

C2C uses only the existing ordinary Chat background tools:

```text
list_threads
read_thread
send_message_to_thread
```

`list_threads` provides real ChatGPT conversation ids and Project ids.
`read_thread` proves a standby marker is in a user turn and verifies direct
message receipts. `send_message_to_thread` accepts compact control messages to
the exact claimed id. A tool acceptance result is not a delivery receipt.
The direct host can surface a user turn after the initial short readback window,
so C2C retains the single in-flight message and continues exact-id reads rather
than creating a duplicate control message.

C2C does not require host-side Chat creation, model mutation, browser control,
UIA, ChatGPT Classic, ChatGPT Work, drafts, clipboard, or private HTTPS calls.
The host verifier checks only these three direct tools.
