# Speaks a script with Windows' built-in voice into a WAV file and writes the true start time of every
# word next to it (<out>.words.json), for testing voiceover alignment. Windows only.
# Usage: powershell -File scripts/make-voiceover.ps1 -Out vo.wav -Text "Line one. Line two." [-Rate 0]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Text,
  [int]$Rate = 0
)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = $Rate
$words = New-Object System.Collections.ArrayList
Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -SourceIdentifier bmProgress | Out-Null
$full = [System.IO.Path]::GetFullPath($Out)
# 16 kHz mono: the rate the engine reports word positions in (other rates skew them).
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($full, $format)
$synth.Speak($Text)
$synth.SetOutputToNull()
foreach ($e in Get-Event -SourceIdentifier bmProgress) {
  $a = $e.SourceEventArgs
  [void]$words.Add([pscustomobject]@{ text = $a.Text; start = [math]::Round($a.AudioPosition.TotalSeconds, 3) })
}
Unregister-Event -SourceIdentifier bmProgress
Get-Event | Remove-Event
$json = ConvertTo-Json -InputObject @($words.ToArray()) -Compress
[System.IO.File]::WriteAllText($full + '.words.json', $json)
Write-Output "wrote $full ($($words.Count) words)"
