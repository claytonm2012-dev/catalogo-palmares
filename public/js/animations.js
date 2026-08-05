// Grupo Palmares — premium interactions (vanilla JS, no dependencies)
(function(){
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pointerFine = window.matchMedia('(pointer:fine)').matches;
  const isSmallScreen = () => window.matchMedia('(max-width:720px)').matches;

  /* ---------- Scroll reveal (cards, tiles, editorial) ---------- */
  function initScrollReveal(){
    const targets = document.querySelectorAll('.scroll-reveal, .product-card, .cat-tile, .editorial-card');
    if (!targets.length) return;
    if (reduced){ targets.forEach(el=>el.classList.add('show')); return; }
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if (entry.isIntersecting){ entry.target.classList.add('show'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12 });
    targets.forEach(el=>io.observe(el));
  }

  /* ---------- Grid scan canvas ----------
     Subtle grid + scan-band accent used behind the product page's main image
     (light background, low-key). */
  function initGridScan(){
    if (reduced) return;
    document.querySelectorAll('.canvas-scan').forEach(canvas=>{
      const ctx = canvas.getContext('2d');
      let DPR = Math.min(window.devicePixelRatio || 1, 2);
      function resize(){ canvas.width = canvas.clientWidth * DPR; canvas.height = canvas.clientHeight * DPR; ctx.setTransform(DPR,0,0,DPR,0,0); }
      resize(); window.addEventListener('resize', resize);
      const particleCount = isSmallScreen() ? 10 : 26;
      let t = 0, raf;
      function render(){
        t += 1.1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h){ raf = requestAnimationFrame(render); return; }
        ctx.clearRect(0,0,canvas.width,canvas.height);
        const cols = Math.max(8, Math.floor(w/64));
        ctx.strokeStyle = 'rgba(212,175,106,0.035)'; ctx.lineWidth = 1;
        for(let x=0;x<=cols;x++){ const px=(x/cols)*w; ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,h); ctx.stroke(); }

        const scanY = ((t*0.55) % (h + 260)) - 130;
        const grad = ctx.createLinearGradient(0, scanY-110, 0, scanY+110);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.4, 'rgba(212,175,106,0.09)');
        grad.addColorStop(0.5, 'rgba(240,217,153,0.14)');
        grad.addColorStop(0.6, 'rgba(212,175,106,0.09)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad; ctx.fillRect(0, scanY-160, w, 320);

        for(let i=0;i<particleCount;i++){
          const px = (i/particleCount)*w + Math.sin((t*0.025)+i)*18;
          const py = ((i*61) % h) + Math.cos((t*0.02)+i)*12;
          const gold = i % 3 === 0;
          ctx.beginPath(); ctx.fillStyle = gold ? 'rgba(240,217,153,0.10)' : 'rgba(127,203,255,0.08)'; ctx.arc(px, py, 1.6, 0, Math.PI*2); ctx.fill();
          ctx.beginPath(); ctx.fillStyle = gold ? 'rgba(240,217,153,0.03)' : 'rgba(127,203,255,0.03)'; ctx.arc(px, py, 4.5, 0, Math.PI*2); ctx.fill();
        }
        raf = requestAnimationFrame(render);
      }
      raf = requestAnimationFrame(render);
    });
  }

  /* ---------- Cursor spotlight on hero showcases ---------- */
  function initSpotlight(){
    if (reduced || !pointerFine) return;
    document.querySelectorAll('.hero-visual').forEach(stage=>{
      let raf = null, tx = 50, ty = 30, cx = 50, cy = 30;
      function loop(){
        cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
        stage.style.setProperty('--sx', cx + '%');
        stage.style.setProperty('--sy', cy + '%');
        raf = requestAnimationFrame(loop);
      }
      stage.addEventListener('mouseenter', ()=>{ if(!raf) raf = requestAnimationFrame(loop); });
      stage.addEventListener('mousemove', e=>{
        const rect = stage.getBoundingClientRect();
        tx = ((e.clientX - rect.left) / rect.width) * 100;
        ty = ((e.clientY - rect.top) / rect.height) * 100;
      });
      stage.addEventListener('mouseleave', ()=>{ if(raf){ cancelAnimationFrame(raf); raf=null; } });
    });
  }

  /* ---------- Header: mega menu, mobile drawer, expandable search, active nav ---------- */
  function initMegaMenu(){
    const trigger = document.getElementById('megaTrigger');
    if (!trigger) return;
    const item = trigger.closest('.nav-item');
    function close(){ item.classList.remove('open'); trigger.setAttribute('aria-expanded','false'); }
    function open(){ item.classList.add('open'); trigger.setAttribute('aria-expanded','true'); }
    trigger.addEventListener('click', (e)=>{ e.stopPropagation(); item.classList.contains('open') ? close() : open(); });
    document.addEventListener('click', (e)=>{ if (!item.contains(e.target)) close(); });
    document.addEventListener('keydown', e=>{ if (e.key === 'Escape') close(); });
  }

  function initDrawer(){
    const toggle = document.getElementById('drawerToggle');
    const drawer = document.getElementById('mobileDrawer');
    if (!toggle || !drawer) return;
    function open(){ drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); toggle.setAttribute('aria-expanded','true'); document.body.style.overflow = 'hidden'; }
    function close(){ drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); toggle.setAttribute('aria-expanded','false'); document.body.style.overflow = ''; }
    toggle.addEventListener('click', open);
    drawer.querySelectorAll('[data-drawer-close]').forEach(el=>el.addEventListener('click', close));
    document.addEventListener('keydown', e=>{ if (e.key === 'Escape') close(); });
  }

  function initHeaderSearch(){
    const toggle = document.getElementById('searchToggle');
    const panel = document.getElementById('headerSearch');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', ()=>{
      const isOpen = panel.classList.toggle('open');
      panel.setAttribute('aria-hidden', String(!isOpen));
      toggle.setAttribute('aria-expanded', String(isOpen));
      if (isOpen){ const input = document.getElementById('headerSearchInput'); if (input) setTimeout(()=>input.focus(), 60); }
    });
  }

  function markActiveNav(){
    const path = window.location.pathname;
    document.querySelectorAll('[data-nav-link]').forEach(a=>{
      const href = a.getAttribute('href');
      if (!href) return;
      if (href === '/' ? path === '/' : path.indexOf(href) === 0){ a.classList.add('active'); }
    });
  }

  /* ---------- Back to top ---------- */
  function initBackToTop(){
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    window.addEventListener('scroll', ()=>{ btn.classList.toggle('show', window.scrollY > 500); }, { passive: true });
    btn.addEventListener('click', ()=> window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }));
  }

  /* ---------- Newsletter (demo-only, no backend) ---------- */
  function initNewsletter(){
    const form = document.getElementById('newsletterForm');
    const note = document.getElementById('newsletterNote');
    if (!form) return;
    form.addEventListener('submit', e=>{ e.preventDefault(); if (note) note.hidden = false; form.reset(); });
  }

  /* ---------- Institutional animated counters ---------- */
  function initCounters(){
    const els = document.querySelectorAll('.count-num[data-count-target]');
    if (!els.length) return;
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const target = parseFloat(el.getAttribute('data-count-target')) || 0;
        io.unobserve(el);
        if (reduced){ el.textContent = String(target); return; }
        const dur = 1400, start = performance.now();
        function step(now){
          const p = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = String(Math.floor(target * eased));
          if (p < 1) requestAnimationFrame(step); else el.textContent = String(target);
        }
        requestAnimationFrame(step);
      });
    }, { threshold: 0.4 });
    els.forEach(el=>io.observe(el));
  }

  /* ---------- QR code modal with scan animation ---------- */
  function initQrModal(){
    const modal = document.getElementById('qrModal');
    const frame = modal ? modal.querySelector('.qr-frame') : null;
    const image = modal ? modal.querySelector('.qr-image') : null;
    const buttons = document.querySelectorAll('[data-qr-sku]');
    if (!buttons.length) return;

    function close(){ if (modal){ modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); } }
    if (modal){
      modal.querySelectorAll('[data-qr-close]').forEach(el=>el.addEventListener('click', close));
      document.addEventListener('keydown', e=>{ if (e.key === 'Escape') close(); });
    }
    buttons.forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const sku = btn.getAttribute('data-qr-sku');
        if (!modal || !frame || !image) return;
        modal.classList.add('open'); modal.setAttribute('aria-hidden','false');
        frame.classList.add('loading'); image.classList.remove('ready');
        try{
          const res = await fetch(`/qr/${encodeURIComponent(sku)}`);
          const json = await res.json();
          image.src = json.qrCode;
          image.onload = ()=>{ frame.classList.remove('loading'); image.classList.add('ready'); };
        }catch(e){ console.error(e); frame.classList.remove('loading'); }
      });
    });
  }

  /* ---------- Product gallery: swipeable carousel + fullscreen modal ----------
     All slides are already rendered server-side (no re-fetching on swipe/tap).
     Pointer Events unify touch drag (mobile) and mouse drag (desktop) in one
     code path. touch-action:pan-y (see CSS) is what keeps vertical page
     scroll working — we only ever transform the track on a horizontal drag. */
  function initProductGallery(){
    const root = document.getElementById('productGallery');
    if (!root) return;
    const track = document.getElementById('pgTrack');
    const slides = Array.from(track.querySelectorAll('.pg-slide'));
    const total = slides.length;
    if (!total) return;
    const prevBtn = document.getElementById('pgPrev');
    const nextBtn = document.getElementById('pgNext');
    const counter = document.getElementById('pgCounter');
    const thumbs = Array.from(document.querySelectorAll('.gallery-thumb[data-index]'));
    const modal = document.getElementById('galleryModal');
    let index = 0;

    slides.forEach(slide => {
      const img = slide.querySelector('img');
      if (!img) { slide.classList.add('pg-loaded'); return; } // placeholder tone, no <img> to wait for
      if (img.complete) slide.classList.add('pg-loaded');
      else {
        img.addEventListener('load', () => slide.classList.add('pg-loaded'));
        img.addEventListener('error', () => slide.classList.add('pg-loaded'));
      }
    });

    function render(withTransition){
      track.classList.toggle('no-transition', !withTransition);
      track.style.transform = `translateX(${-index * 100}%)`;
      if (counter) counter.textContent = (index + 1) + ' / ' + total;
      thumbs.forEach(t => t.classList.toggle('active', Number(t.getAttribute('data-index')) === index));
    }
    function go(i){ index = (i + total) % total; render(true); }
    function next(){ go(index + 1); }
    function prev(){ go(index - 1); }

    if (total < 2){
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      if (counter) counter.style.display = 'none';
    } else {
      prevBtn && prevBtn.addEventListener('click', prev);
      nextBtn && nextBtn.addEventListener('click', next);
    }
    thumbs.forEach(thumb=>{
      thumb.addEventListener('click', ()=>{
        const i = Number(thumb.getAttribute('data-index'));
        if (!Number.isNaN(i)) go(i);
      });
    });

    root.setAttribute('tabindex', '0');
    root.addEventListener('keydown', e=>{
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'Enter') openModal(index);
    });
    render(false);

    /* ---- fullscreen modal (opens on a tap/click that wasn't a drag) ---- */
    function openModal(i){
      if (!modal) return;
      modalIndex = i;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      renderModal(false);
    }

    /* ---- drag/swipe: follows the finger, snaps on release ----
       <img> is natively draggable in every desktop browser — without this,
       a mouse drag starts an HTML5 dragstart/ghost-image instead of firing
       pointermove, so the swipe below would never see the movement. */
    root.addEventListener('dragstart', e => e.preventDefault());

    let startX = 0, startY = 0, dx = 0, dragging = false, moved = false;
    const trackWidth = () => root.clientWidth || 1;

    root.addEventListener('pointerdown', e=>{
      if (e.target.closest('.pg-arrow')) return;
      dragging = true; moved = false; startX = e.clientX; startY = e.clientY; dx = 0;
      if (total > 1) track.classList.add('no-transition');
      root.classList.add('dragging');
      root.setPointerCapture && root.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove', e=>{
      if (!dragging) return;
      const curDx = e.clientX - startX, curDy = e.clientY - startY;
      if (!moved && Math.abs(curDx) < 6 && Math.abs(curDy) < 6) return;
      if (Math.abs(curDy) > Math.abs(curDx) && Math.abs(curDx) < 30) return; // vertical scroll wins
      moved = true; dx = curDx;
      if (total > 1){
        const pct = (dx / trackWidth()) * 100;
        track.style.transform = `translateX(${(-index * 100) + pct}%)`;
      }
    });
    function endDrag(){
      if (!dragging) return;
      dragging = false;
      root.classList.remove('dragging');
      if (total > 1){
        track.classList.remove('no-transition');
        const threshold = trackWidth() * 0.18;
        if (moved && Math.abs(dx) > threshold){ dx < 0 ? next() : prev(); }
        else render(true);
      }
      if (!moved) openModal(index);
      dx = 0; moved = false;
    }
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);

    if (!modal) return;
    const modalTrack = modal.querySelector('.gallery-modal-track');
    const modalCounter = modal.querySelector('.gallery-modal-counter');
    const modalPrev = modal.querySelector('.gallery-modal-prev');
    const modalNext = modal.querySelector('.gallery-modal-next');
    let modalIndex = 0;

    function renderModal(withTransition){
      modalTrack.classList.toggle('no-transition', !withTransition);
      modalTrack.style.transform = `translateX(${-modalIndex * 100}%)`;
      if (modalCounter) modalCounter.textContent = (modalIndex + 1) + ' / ' + total;
    }
    function closeModal(){
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      modalTrack.querySelectorAll('img.zoomed').forEach(img=>img.classList.remove('zoomed'));
    }
    function modalNextFn(){ modalIndex = (modalIndex + 1) % total; renderModal(true); }
    function modalPrevFn(){ modalIndex = (modalIndex - 1 + total) % total; renderModal(true); }

    modal.querySelectorAll('[data-gallery-close]').forEach(el=>el.addEventListener('click', closeModal));
    modalPrev && modalPrev.addEventListener('click', modalPrevFn);
    modalNext && modalNext.addEventListener('click', modalNextFn);
    document.addEventListener('keydown', e=>{
      if (!modal.classList.contains('open')) return;
      if (e.key === 'Escape') closeModal();
      if (e.key === 'ArrowRight') modalNextFn();
      if (e.key === 'ArrowLeft') modalPrevFn();
    });

    modalTrack.addEventListener('dragstart', e => e.preventDefault());
    let mStartX = 0, mStartY = 0, mDx = 0, mDragging = false, mMoved = false;
    modalTrack.addEventListener('pointerdown', e=>{
      if (total < 2) return;
      mDragging = true; mMoved = false; mStartX = e.clientX; mStartY = e.clientY; mDx = 0;
      modalTrack.classList.add('no-transition');
      modalTrack.setPointerCapture && modalTrack.setPointerCapture(e.pointerId);
    });
    modalTrack.addEventListener('pointermove', e=>{
      if (!mDragging) return;
      const curDx = e.clientX - mStartX, curDy = e.clientY - mStartY;
      if (!mMoved && Math.abs(curDx) < 6 && Math.abs(curDy) < 6) return;
      if (Math.abs(curDy) > Math.abs(curDx) && Math.abs(curDx) < 30) return;
      mMoved = true; mDx = curDx;
      const pct = (mDx / (modal.clientWidth || 1)) * 100;
      modalTrack.style.transform = `translateX(${(-modalIndex * 100) + pct}%)`;
    });
    function endModalDrag(){
      if (!mDragging) return;
      mDragging = false;
      modalTrack.classList.remove('no-transition');
      const threshold = (modal.clientWidth || 1) * 0.18;
      if (mMoved && Math.abs(mDx) > threshold){ mDx < 0 ? modalNextFn() : modalPrevFn(); }
      else renderModal(true);
      mDx = 0; mMoved = false;
    }
    modalTrack.addEventListener('pointerup', endModalDrag);
    modalTrack.addEventListener('pointercancel', endModalDrag);

    // Zoom is optional per the spec — a lightweight double-tap/double-click
    // toggle (2x) rather than full pinch-zoom, kept dependency-free.
    modalTrack.querySelectorAll('img').forEach(img=>{
      let lastTap = 0;
      img.addEventListener('click', ()=>{
        const now = Date.now();
        if (now - lastTap < 320) img.classList.toggle('zoomed');
        lastTap = now;
      });
    });
  }

  /* ---------- Hero cinematic carousel ---------- */
  function initHeroCarousel(){
    const hero = document.getElementById('heroCarousel');
    if (!hero) return;
    const slides = Array.from(hero.querySelectorAll('.hero-slide'));
    if (!slides.length) return;
    const dots = Array.from(hero.querySelectorAll('.hero-dot'));
    const prevBtn = document.getElementById('heroPrev');
    const nextBtn = document.getElementById('heroNext');
    const progressSpan = hero.querySelector('#heroProgress span');
    const AUTOPLAY_MS = 8000;
    let index = 0, rafId = null, progressStart = 0, paused = false;

    function render(){
      slides.forEach((s,i)=>s.classList.toggle('active', i===index));
      dots.forEach((d,i)=>d.classList.toggle('active', i===index));
    }
    function go(i){ index = (i + slides.length) % slides.length; render(); restartProgress(); }
    function next(){ go(index + 1); }
    function prev(){ go(index - 1); }

    function restartProgress(){
      cancelAnimationFrame(rafId);
      if (reduced || slides.length < 2){ if (progressSpan) progressSpan.style.width = '0%'; return; }
      progressStart = performance.now();
      function step(now){
        if (paused){ progressStart += 16; rafId = requestAnimationFrame(step); return; }
        const elapsed = now - progressStart;
        const pct = Math.min(100, (elapsed / AUTOPLAY_MS) * 100);
        if (progressSpan) progressSpan.style.width = pct + '%';
        if (elapsed >= AUTOPLAY_MS){ next(); return; }
        rafId = requestAnimationFrame(step);
      }
      rafId = requestAnimationFrame(step);
    }

    prevBtn && prevBtn.addEventListener('click', prev);
    nextBtn && nextBtn.addEventListener('click', next);
    dots.forEach((d,i)=> d.addEventListener('click', ()=> go(i)));
    hero.addEventListener('mouseenter', ()=>{ paused = true; });
    hero.addEventListener('mouseleave', ()=>{ paused = false; });

    hero.setAttribute('tabindex', '0');
    hero.addEventListener('keydown', e=>{
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    });

    let touchX = null;
    const slidesWrap = hero.querySelector('.hero-slides');
    slidesWrap.addEventListener('touchstart', e=>{ touchX = e.touches[0].clientX; paused = true; }, { passive: true });
    slidesWrap.addEventListener('touchend', e=>{
      if (touchX !== null){
        const dx = e.changedTouches[0].clientX - touchX;
        if (Math.abs(dx) > 40){ dx < 0 ? next() : prev(); }
      }
      touchX = null; paused = false;
    }, { passive: true });

    const cue = document.getElementById('heroScrollCue');
    if (cue){ window.addEventListener('scroll', ()=>{ cue.classList.toggle('hidden', window.scrollY > 40); }, { passive: true }); }

    render();
    restartProgress();
  }

  /* ---------- Coverflow carousel (Lançamentos) ---------- */
  function initCoverflow(){
    const cf = document.getElementById('launchesCoverflow');
    if (!cf) return;
    const slides = Array.from(cf.querySelectorAll('.coverflow-slide'));
    if (!slides.length) return;
    const prevBtn = document.getElementById('cfPrev');
    const nextBtn = document.getElementById('cfNext');
    const progressBar = document.getElementById('cfProgressBar');
    const counter = document.getElementById('cfCurrent');
    let active = 0, timer = null;

    function clearInline(){
      slides.forEach(s=>{ s.style.transform=''; s.style.opacity=''; s.style.filter=''; s.style.zIndex=''; s.style.pointerEvents=''; s.classList.remove('is-active'); });
    }

    function layout(){
      if (isSmallScreen()){ clearInline(); updateMeta(); return; }
      slides.forEach((slide, i)=>{
        const diff = i - active;
        const abs = Math.abs(diff);
        slide.classList.toggle('is-active', diff === 0);
        if (abs > 3){ slide.style.opacity = '0'; slide.style.pointerEvents = 'none'; slide.style.zIndex = '0'; slide.style.transform = `translateY(-50%) translateX(${diff*220}px) scale(.5)`; return; }
        const tx = diff * 220;
        const scale = 1 - abs * 0.14;
        const rotate = diff * -10;
        slide.style.transform = `translateY(-50%) translateX(${tx}px) scale(${scale}) rotateY(${rotate}deg)`;
        slide.style.opacity = String(Math.max(0, 1 - abs * 0.32));
        slide.style.filter = abs === 0 ? 'none' : `blur(${abs * 1.4}px)`;
        slide.style.zIndex = String(100 - abs);
        // Only the active card and its immediate neighbours are clickable —
        // farther cards are nearly invisible but a rotateY'd element still
        // reports a large bounding box, which would otherwise steal clicks
        // from the arrow buttons sitting underneath.
        slide.style.pointerEvents = abs <= 1 ? 'auto' : 'none';
      });
      updateMeta();
    }
    function updateMeta(){
      if (counter) counter.textContent = String(active + 1);
      if (progressBar) progressBar.style.width = (((active + 1) / slides.length) * 100) + '%';
    }
    function go(i){ active = (i + slides.length) % slides.length; layout(); }
    function next(){ go(active + 1); }
    function prev(){ go(active - 1); }
    function start(){ stop(); if (reduced || slides.length < 2 || isSmallScreen()) return; timer = setInterval(next, 4800); }
    function stop(){ if (timer) clearInterval(timer); timer = null; }

    slides.forEach((slide, i)=> slide.addEventListener('click', ()=>{ if (i !== active) { go(i); start(); } }));
    prevBtn && prevBtn.addEventListener('click', ()=>{ prev(); start(); });
    nextBtn && nextBtn.addEventListener('click', ()=>{ next(); start(); });
    cf.addEventListener('mouseenter', stop);
    cf.addEventListener('mouseleave', start);
    cf.addEventListener('keydown', e=>{
      if (e.key === 'ArrowRight'){ next(); start(); }
      if (e.key === 'ArrowLeft'){ prev(); start(); }
    });

    let touchX = null;
    cf.addEventListener('touchstart', e=>{ touchX = e.touches[0].clientX; }, { passive: true });
    cf.addEventListener('touchend', e=>{
      if (touchX !== null && !isSmallScreen()){
        const dx = e.changedTouches[0].clientX - touchX;
        if (Math.abs(dx) > 40){ dx < 0 ? next() : prev(); start(); }
      }
      touchX = null;
    }, { passive: true });

    window.addEventListener('resize', layout);
    layout();
    start();
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    markActiveNav();
    initScrollReveal();
    initGridScan();
    initSpotlight();
    initMegaMenu();
    initDrawer();
    initHeaderSearch();
    initBackToTop();
    initNewsletter();
    initCounters();
    initQrModal();
    initProductGallery();
    initHeroCarousel();
    initCoverflow();

    const header = document.querySelector('.header');
    if (header){ window.addEventListener('scroll', ()=>{ header.classList.toggle('solid', window.scrollY > 30); }, { passive: true }); }
  });
})();
