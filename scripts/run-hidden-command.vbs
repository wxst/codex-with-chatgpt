Option Explicit

If WScript.Arguments.Count < 1 Then
  WScript.Quit 87
End If

Function QuoteArgument(ByVal value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Dim command, index, shell
command = QuoteArgument(WScript.Arguments(0))
For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

Set shell = CreateObject("WScript.Shell")
' Wait for the long-lived supervisor so Task Scheduler's MultipleInstances
' policy owns the real process and does not launch one duplicate per trigger.
shell.Run command, 0, True
