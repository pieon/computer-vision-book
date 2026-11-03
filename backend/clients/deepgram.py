import os
import asyncio
from deepgram import (
    DeepgramClient,
    LiveTranscriptionEvents,
    LiveOptions,
)


async def transcribe(): 
    """Send live audio to Deepgram for transcription and return the response."""
    try:
        # Initialize the Deepgram client using the API key
        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is missing from environment variables.")
        
        deepgram = DeepgramClient(api_key)

        # Create a WebSocket connection client
        dg_connection = deepgram.listen.asyncwebsocket.v1()

        # Define what happens when a real-time transcript is received
        def on_message(self, result, **kwargs):
            sentence = result.channel.alternatives[0].transcript
            if len(sentence) > 0:
                print(f"Transcript: {sentence}")

        # Define error handling behavior
        def on_error(self, error, **kwargs):
            print(f"Error encountered: {error}")

        # Register event listeners
        dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        dg_connection.on(LiveTranscriptionEvents.Error, on_error)

        # Configure real-time streaming options with nova-3
        options = LiveOptions(
            model="nova-3",
            language="en-US",
            smart_format=True,   # Punctuation and capitalization
            interim_results=True # Low-latency partial transcript updates
        )

        print("Connecting to Deepgram WebSocket...")
        if await dg_connection.start(options) is False:
            print("Failed to connect to Deepgram.")
            return

        print("Connected! Streaming audio...")

        # Simulation: In production, substitute this loop with live audio data 
        # from a microphone stream (e.g., PyAudio) or a remote stream.
        try:
            while True:
                # 1024 bytes of empty audio buffer as a placeholder
                fake_audio_chunk = b'\x00' * 1024 
                await dg_connection.send(fake_audio_chunk)
                await asyncio.sleep(0.05) # Keep a steady payload pacing
        except asyncio.CancelledError:
            print("Streaming paused or stopped.")
        
        # Safely shut down the connection when done
        await dg_connection.finish()
        print("Connection closed successfully.")

    except Exception as e:
        print(f"An exception occurred: {e}")
