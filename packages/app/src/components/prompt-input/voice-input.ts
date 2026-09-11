import { createSignal, onCleanup } from "solid-js"

export function createVoiceInput(onTranscript: (text: string) => void) {
  const [recording, setRecording] = createSignal(false)

  let recognition: any = null

  function ensureRecognition(): boolean {
    if (recognition) return true
    if (typeof window === "undefined") return false
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return false
    recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = "en-US"

    recognition.onresult = (event: any) => {
      let finalTranscript = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript
        }
      }
      if (finalTranscript) {
        onTranscript(finalTranscript)
      }
    }

    recognition.onerror = () => {
      setRecording(false)
    }

    recognition.onend = () => {
      setRecording(false)
    }

    return true
  }

  const toggle = () => {
    if (recording()) {
      if (recognition) recognition.stop()
      setRecording(false)
      return
    }
    if (!ensureRecognition()) return
    try {
      recognition.start()
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }

  onCleanup(() => {
    if (recognition && recording()) {
      recognition.stop()
    }
  })

  return { recording, toggle }
}
