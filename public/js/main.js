// Proshop - interacciones del sitio
(function () {
  'use strict';

  // ---- Menu movil ----
  const toggle = document.querySelector('.nav-toggle');
  const menu = document.querySelector('.mobile-menu');
  if (toggle && menu) {
    const setOpen = (open) => {
      menu.hidden = !open;
      menu.style.display = open ? 'flex' : 'none';
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(menu.hidden));
    menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  }

  // ---- Reveal al hacer scroll ----
  const items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    items.forEach((el) => io.observe(el));
  } else {
    items.forEach((el) => el.classList.add('in'));
  }

  // ---- Formulario de contacto ----
  const form = document.getElementById('contactForm');
  const note = document.getElementById('formNote');
  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const data = Object.fromEntries(new FormData(form).entries());

      note.className = 'form-note';
      note.textContent = 'Enviando...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/contacto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const out = await res.json();

        if (res.ok && out.ok) {
          note.className = 'form-note ok';
          note.textContent = out.mensaje || '¡Gracias! Te contactaremos pronto.';
          form.reset();
          // Ofrece continuar por WhatsApp
          if (out.whatsappUrl) {
            window.open(out.whatsappUrl, '_blank', 'noopener');
          }
        } else {
          note.className = 'form-note err';
          note.textContent = out.error || 'Ocurrió un error. Intenta de nuevo.';
        }
      } catch (err) {
        note.className = 'form-note err';
        note.textContent = 'No se pudo enviar. Revisa tu conexión e intenta de nuevo.';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---- Año dinamico (por si se usa en algun lugar) ----
  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = new Date().getFullYear();
  });
})();
