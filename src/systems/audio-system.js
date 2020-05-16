async function enableChromeAEC(gainNode) {
  /**
   *  workaround for: https://bugs.chromium.org/p/chromium/issues/detail?id=687574
   *  1. grab the GainNode from the scene's THREE.AudioListener
   *  2. disconnect the GainNode from the AudioDestinationNode (basically the audio out), this prevents hearing the audio twice.
   *  3. create a local webrtc connection between two RTCPeerConnections (see this example: https://webrtc.github.io/samples/src/content/peerconnection/pc1/)
   *  4. create a new MediaStreamDestination from the scene's THREE.AudioContext and connect the GainNode to it.
   *  5. add the MediaStreamDestination's track  to one of those RTCPeerConnections
   *  6. connect the other RTCPeerConnection's stream to a new audio element.
   *  All audio is now routed through Chrome's audio mixer, thus enabling AEC, while preserving all the audio processing that was performed via the WebAudio API.
   */

  const audioEl = new Audio();
  audioEl.setAttribute("autoplay", "autoplay");
  audioEl.setAttribute("playsinline", "playsinline");

  const context = THREE.AudioContext.getContext();
  const loopbackDestination = context.createMediaStreamDestination();
  const outboundPeerConnection = new RTCPeerConnection();
  const inboundPeerConnection = new RTCPeerConnection();

  const onError = e => {
    console.error("RTCPeerConnection loopback initialization error", e);
  };

  outboundPeerConnection.addEventListener("icecandidate", e => {
    inboundPeerConnection.addIceCandidate(e.candidate).catch(onError);
  });

  inboundPeerConnection.addEventListener("icecandidate", e => {
    outboundPeerConnection.addIceCandidate(e.candidate).catch(onError);
  });

  inboundPeerConnection.addEventListener("track", e => {
    audioEl.srcObject = e.streams[0];
  });

  gainNode.disconnect();
  gainNode.connect(loopbackDestination);

  loopbackDestination.stream.getTracks().forEach(track => {
    outboundPeerConnection.addTrack(track, loopbackDestination.stream);
  });

  const offer = await outboundPeerConnection.createOffer().catch(onError);
  outboundPeerConnection.setLocalDescription(offer).catch(onError);
  await inboundPeerConnection.setRemoteDescription(offer).catch(onError);

  const answer = await inboundPeerConnection.createAnswer();
  inboundPeerConnection.setLocalDescription(answer).catch(onError);
  outboundPeerConnection.setRemoteDescription(answer).catch(onError);
}

export class AudioSystem {
  constructor(sceneEl) {
    sceneEl.audioListener = sceneEl.audioListener || new THREE.AudioListener();
    if (sceneEl.camera) {
      sceneEl.camera.add(sceneEl.audioListener);
    }
    sceneEl.addEventListener("camera-set-active", evt => {
      evt.detail.cameraEl.getObject3D("camera").add(sceneEl.audioListener);
    });

    const ctx = THREE.AudioContext.getContext();
    this.outboundContext = new (window.AudioContext || window.webkitAudioContext)();
    this.audioNodes = new Map();

    /**
     * Chrome and Safari will start Audio contexts in a "suspended" state.
     * A user interaction (touch/mouse event) is needed in order to resume the AudioContext.
     */
    const resume = () => {
      ctx.resume();
      this.outboundContext.resume();

      setTimeout(() => {
        if (ctx.state === "running" && this.outboundContext.state === "running") {
          if (!AFRAME.utils.device.isMobile() && /chrome/i.test(navigator.userAgent)) {
            enableChromeAEC(sceneEl.audioListener.gain);
          }

          this.mediaStreamDestinationNode = this.outboundContext.createMediaStreamDestination();
          this.outboundStream = this.mediaStreamDestinationNode.stream;
          this.outboundGainNode = this.outboundContext.createGain();
          this.outboundAnalyser = this.outboundContext.createAnalyser();
          this.outboundAnalyser.fftSize = 32;
          this.analyserLevels = new Uint8Array(this.outboundAnalyser.fftSize);
          this.outboundGainNode.connect(this.outboundAnalyser);
          this.outboundAnalyser.connect(this.mediaStreamDestinationNode);

          document.body.removeEventListener("touchend", resume, false);
          document.body.removeEventListener("mouseup", resume, false);
        }
      }, 0);
    };

    document.body.addEventListener("touchend", resume, false);
    document.body.addEventListener("mouseup", resume, false);
  }

  addStreamToOutboundAudio(id, mediaStream) {
    if (this.audioNodes.has(id)) {
      this.removeStreamFromOutboundAudio(id);
    }

    const sourceNode = this.outboundContext.createMediaStreamSource(mediaStream);
    const gainNode = this.outboundContext.createGain();
    sourceNode.connect(gainNode);
    gainNode.connect(this.outboundGainNode);
    this.audioNodes.set(id, { sourceNode, gainNode });
  }

  removeStreamFromOutboundAudio(id) {
    if (this.audioNodes.has(id)) {
      const nodes = this.audioNodes.get(id);
      nodes.sourceNode.disconnect();
      nodes.gainNode.disconnect();
      this.audioNodes.delete(id);
    }
  }
}
