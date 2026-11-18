type SignalSender = (data: {
  type: 'voice:offer' | 'voice:answer' | 'voice:ice' | 'voice:state';
  targetId?: string;
  payload?: any;
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
      return true;
    } catch (err) {
      console.error('無法取得麥克風權限:', err);
      alert('無法開啟麥克風，請確認瀏覽器已允許麥克風權限。');
      return false;
    }
  }

  setMute(muted: boolean) {
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

  async connectToPeer(targetId: string) {
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

  async handleSignal(msg: any) {
    const { type, fromId, payload } = msg;

    if (type === 'voice:offer') {
      const pc = this.createPeerConnection(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.sendSignal({
        type: 'voice:answer',
        targetId: fromId,
        payload: answer,
      });
    } else if (type === 'voice:answer') {
      const pc = this.peers.get(fromId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
      }
    } else if (type === 'voice:ice') {
      const pc = this.peers.get(fromId);
      if (pc && payload) {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
      }
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId)!;
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(peerId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: 'voice:ice',
          targetId: peerId,
          payload: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      let audio = this.audioElements.get(peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
        this.audioElements.set(peerId, audio);
      }
      audio.srcObject = event.streams[0];
    };

    return pc;
  }

  removePeer(peerId: string) {
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

  destroyAll() {
    this.peers.forEach((_, id) => this.removePeer(id));
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
