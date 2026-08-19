/*!
 * Окно «О проекте». Открывается по любой ссылке, ведущей на #about,
 * с какой бы страницы её ни нажали. Закрывается крестиком, Escape
 * и щелчком по затемнению.
 */
const HTML = `
<dialog class="modal" id="aboutModal">
  <button class="modal__x" id="aboutClose" aria-label="Закрыть">&times;</button>
  <h2>О проекте</h2>
  <p>Здесь живут игры, собранные соло-разработчиками — часто за пару недель и часто из совершенно безумной идеи.
     Ничего скачивать не нужно: всё запускается прямо в браузере, прогресс сохраняется, рекорды считаются.</p>
  <p>Площадка молодая и растёт живьём: новые игры появляются по мере того, как их доделывают.
     Если вы тоже делаете игры — <a href="./partners.html">приходите в раздел для партнёров</a>.</p>
</dialog>`;

export function mountAbout() {
  if (document.getElementById('aboutModal')) return;
  document.body.insertAdjacentHTML('beforeend', HTML);

  const modal = document.getElementById('aboutModal');
  document.getElementById('aboutClose').onclick = () => modal.close();

  // щелчок мимо содержимого — закрываем
  modal.addEventListener('click', (e) => {
    const box = modal.getBoundingClientRect();
    const outside = e.clientX < box.left || e.clientX > box.right ||
                    e.clientY < box.top || e.clientY > box.bottom;
    if (outside) modal.close();
  });

  document.querySelectorAll('a[href$="#about"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      modal.showModal();
    });
  });
}
