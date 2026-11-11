// ==========================================================================
// MumaLINK Neural Bio-Synaptic Canvas Animation
// Neuralink-inspired neural mesh with MumaLINK brand palette:
// Coral (#E2755D), Teal (#4DA0A5), Slate Blue (#78A1AB), Luminous White
// ==========================================================================

(function() {
  const canvas = document.getElementById('neuralCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let width, height;
  let dpr = window.devicePixelRatio || 1;

  let nodes = [];
  let pulses = [];
  const MAX_NODES = 65;
  const CONNECTION_DIST = 175;

  const BRAND_PALETTE = [
    { r: 226, g: 117, b: 93 },   // Warm Coral / Maternal
    { r: 77,  g: 160, b: 165 },  // Clinical Teal / Bio-AI
    { r: 120, g: 161, b: 171 },  // Synaptic Slate
    { r: 245, g: 245, b: 250 }   // Luminous Core
  ];

  // Mouse interaction state
  const mouse = {
    x: -1000,
    y: -1000,
    radius: 220
  };

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  window.addEventListener('mouseleave', () => {
    mouse.x = -1000;
    mouse.y = -1000;
  });

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    initNodes();
  }

  window.addEventListener('resize', resize);

  // Neural Node Class
  class Node {
    constructor() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.vx = (Math.random() - 0.5) * 0.35;
      this.vy = (Math.random() - 0.5) * 0.35;
      this.radius = Math.random() * 1.6 + 1.2;
      this.color = BRAND_PALETTE[Math.floor(Math.random() * BRAND_PALETTE.length)];
      this.baseAlpha = Math.random() * 0.4 + 0.2;
      this.alpha = this.baseAlpha;
      this.pulseRing = 0;
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;

      if (this.x < 0) this.x = width;
      if (this.x > width) this.x = 0;
      if (this.y < 0) this.y = height;
      if (this.y > height) this.y = 0;

      // Mouse proximity stimulus
      const dx = mouse.x - this.x;
      const dy = mouse.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < mouse.radius) {
        const factor = 1 - dist / mouse.radius;
        this.alpha = Math.min(0.95, this.baseAlpha + factor * 0.65);
        this.pulseRing = Math.max(this.pulseRing, factor * 9);
      } else {
        this.alpha = this.baseAlpha;
        if (this.pulseRing > 0) this.pulseRing -= 0.25;
      }
    }

    draw() {
      const { r, g, b } = this.color;

      // Stimulus ring
      if (this.pulseRing > 0) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius + this.pulseRing, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${this.pulseRing * 0.06})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      // Core particle
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${this.alpha})`;
      ctx.shadowBlur = 6;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${this.alpha * 0.6})`;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Neural Pulse Class (Signal packets traveling along synaptic links)
  class Pulse {
    constructor(startNode, endNode) {
      this.start = startNode;
      this.end = endNode;
      this.progress = 0;
      this.speed = Math.random() * 0.018 + 0.012;
      this.size = Math.random() * 1.6 + 1.0;
      this.color = startNode.color;
    }

    update() {
      this.progress += this.speed;
    }

    draw() {
      const curX = this.start.x + (this.end.x - this.start.x) * this.progress;
      const curY = this.start.y + (this.end.y - this.start.y) * this.progress;
      const { r, g, b } = this.color;

      ctx.beginPath();
      ctx.arc(curX, curY, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.95)`;
      ctx.shadowBlur = 12;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function initNodes() {
    nodes = [];
    pulses = [];
    const count = Math.min(MAX_NODES, Math.floor((width * height) / 18000));
    for (let i = 0; i < count; i++) {
      nodes.push(new Node());
    }
  }

  function spawnPulse() {
    if (nodes.length < 2) return;
    if (pulses.length > 25) return;

    const startIdx = Math.floor(Math.random() * nodes.length);
    const start = nodes[startIdx];

    // Find a connected neighbor
    for (let j = 0; j < nodes.length; j++) {
      if (startIdx === j) continue;
      const other = nodes[j];
      const dx = other.x - start.x;
      const dy = other.y - start.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < CONNECTION_DIST) {
        pulses.push(new Pulse(start, other));
        break;
      }
    }
  }

  function drawConnections() {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CONNECTION_DIST) {
          const strength = (1 - dist / CONNECTION_DIST);
          
          // Check proximity to mouse
          const midX = (nodes[i].x + nodes[j].x) / 2;
          const midY = (nodes[i].y + nodes[j].y) / 2;
          const mouseDist = Math.sqrt((mouse.x - midX) ** 2 + (mouse.y - midY) ** 2);
          
          let lineAlpha = strength * 0.12;
          if (mouseDist < mouse.radius) {
            lineAlpha += (1 - mouseDist / mouse.radius) * 0.28;
          }

          // Blend line color between connected nodes
          const c1 = nodes[i].color;
          const c2 = nodes[j].color;
          const grad = ctx.createLinearGradient(nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y);
          grad.addColorStop(0, `rgba(${c1.r}, ${c1.g}, ${c1.b}, ${lineAlpha})`);
          grad.addColorStop(1, `rgba(${c2.r}, ${c2.g}, ${c2.b}, ${lineAlpha})`);

          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }
      }
    }
  }

  // Animation Loop
  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, width, height);

    // Update and draw nodes
    nodes.forEach(node => {
      node.update();
      node.draw();
    });

    // Draw synaptic thread connections
    drawConnections();

    // Pulse management
    if (frame % 28 === 0) {
      spawnPulse();
    }

    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.update();
      p.draw();
      if (p.progress >= 1) {
        pulses.splice(i, 1);
      }
    }

    frame++;
    requestAnimationFrame(animate);
  }

  resize();
  animate();
})();
