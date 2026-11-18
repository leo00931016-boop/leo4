type VoiceSignalPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

type SignalSender = (data: {
  type: 'voice:offer' | 'voice:answer' | 'voice:ice' | 'voice:state';
  targetId?: string;
  payload?: VoiceSignalPayload;
  isMuted?: boolean;
}) => void;

export class VoiceChatManager {
  private localStream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private isMuted = true;
  private sendSignal: SignalSender;

  private rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  constructor(sendSignal: SignalSender) {
    this.sendSignal = sendSignal;
  }

  async enableMic(): Promise<boolean> {
    try {
      const isNewStream = !this.localStream;
      if (!this.localStream) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      }

      this.setMute(false);

      // 如果在開麥之前已經和房間內其他玩家建立過連線，必須把音軌補進去並重新發送 Offer
      if (isNewStream && this.localStream) {
        for (const [peerId, pc] of this.peers.entries()) {
          const senders = pc.getSenders();
          this.localStream.getTracks().forEach((track) => {
            if (!senders.some((s) => s.track === track)) {
              pc.addTrack(track, this.localStream!);
            }
          });
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.sendSignal({
            type: 'voice:offer',
            targetId: peerId,
            payload: offer,
          });
        }
      }

      // 順便解除瀏覽器對所有遠端音訊的自動播放限制
      this.audioElements.forEach((audio) => {
        audio.play().catch(() => {});
      });

      return true;
    } catch (err) {
      console.error('無法取得麥克風權限:', err);
      alert('無法開啟麥克風，請確認瀏覽器已允許麥克風權限。');
      return false;
    }
  }

  setMute(muted: boolean): void {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    this.sendSignal({ type: 'voice:state', isMuted: muted });
  }

  getMutedState(): boolean {
    return this.isMuted;
  }

  async connectToPeer(targetId: string): Promise<void> {
    if (this.peers.has(targetId)) return;
    const pc = this.createPeerConnection(targetId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.sendSignal({
      type: 'voice:offer',
      targetId,
      payload: offer,
    });
  }

  async handleSignal(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type;
    const fromId = typeof msg.fromId === 'string' ? msg.fromId : '';
    const payload = msg.payload;
    if (!fromId) return;

    if (type === 'voice:offer' && payload) {
      const pc = this.createPeerConnection(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(payload as RTCSessionDescriptionInit));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.sendSignal({
        type: 'voice:answer',
        targetId: fromId,
        payload: answer,
      });
    } else if (type === 'voice:answer' && payload) {
      const pc = this.peers.get(fromId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload as RTCSessionDescriptionInit));
      }
    } else if (type === 'voice:ice' && payload) {
      const pc = this.peers.get(fromId);
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(payload as RTCIceCandidateInit));
      }
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(peerId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        this.sendSignal({
          type: 'voice:ice',
          targetId: peerId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      let audio = this.audioElements.get(peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', 'true');
        document.body.appendChild(audio);
        this.audioElements.set(peerId, audio);
      }
      if (event.streams[0]) {
        audio.srcObject = event.streams[0];
        audio.play().catch(() => {});
      }
    };

    return pc;
  }

  removePeer(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }
    const audio = this.audioElements.get(peerId);
    if (audio) {
      audio.remove();
      this.audioElements.delete(peerId);
    }
  }

  destroyAll(): void {
    this.peers.forEach((_, id) => this.removePeer(id));
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
