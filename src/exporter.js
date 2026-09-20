import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality, canEncodeVideo, canEncodeAudio } from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { drawFrame, loadProjectFonts } from '../dist/renderer.js';

export async function exportVideo(project, audioBuffer, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const quality = new Quality({ bitrate: 5_000_000 });
  if (!(await canEncodeVideo('avc', { width: 1920, height: 1080, frameRate: 30, quality }))) {
    throw new Error('このブラウザではH.264動画を作成できません。最新版のChromeまたはEdgeでプロジェクトを開いてください。');
  }
  const audioQuality = new Quality({ bitrate: 320_000 });
  if (!(await canEncodeAudio('aac', { sampleRate: audioBuffer.sampleRate, numberOfChannels: 2, quality: audioQuality }))) registerAacEncoder();
  await loadProjectFonts(project);
  signal?.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = 1920; canvas.height = 1080;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: 'avc', quality, keyFrameInterval: 2 });
  const audio = new AudioBufferSource({ codec: 'aac', quality: audioQuality });
  output.addVideoTrack(video, { frameRate: 30 });
  output.addAudioTrack(audio);
  // Never copy input metadata such as artist names to the exported file.
  const frames = Math.ceil(audioBuffer.duration * 30);
  const sampleRate = audioBuffer.sampleRate;
  let sampleCursor = 0;
  try {
    await output.start();
    for (let f = 0; f < frames; f++) {
      signal?.throwIfAborted();
      const time = f / 30;
      // Interleave audio and video in one-second batches, with bounded temporary PCM memory.
      if (f % 30 === 0 && sampleCursor < audioBuffer.length) {
        const size = Math.min(sampleRate, audioBuffer.length - sampleCursor);
        const chunk = new AudioBuffer({ length: size, sampleRate, numberOfChannels: 2 });
        for (let channel = 0; channel < 2; channel++) chunk.copyToChannel(audioBuffer.getChannelData(Math.min(channel, audioBuffer.numberOfChannels - 1)).subarray(sampleCursor, sampleCursor + size), channel);
        await audio.add(chunk);
        sampleCursor += size;
      }
      drawFrame(canvas, project, time);
      await video.add(time, Math.min(1 / 30, audioBuffer.duration - time));
      if (f % 8 === 0) {
        onProgress(Math.min(98, (f + 1) / frames * 98));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    signal?.throwIfAborted();
    video.close(); audio.close();
    onProgress(99);
    await output.finalize();
    signal?.throwIfAborted();
    onProgress(100);
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (error) {
    try { await output.cancel(); } catch { /* Preserve the original error. */ }
    throw error;
  } finally { canvas.width = canvas.height = 1; }
}
