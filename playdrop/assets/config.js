// Единственный файл, который нужно править под себя.
export const CONFIG = {
  brand: 'PLAYDROP',
  domain: 'playdrop.ru',

  supabase: {
    url: 'https://ilakyvpxasjtoprdbvpj.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsYWt5dnB4YXNqdG9wcmRidnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4OTczMTUsImV4cCI6MjEwMjQ3MzMxNX0.yXaG7Yz6zoEoO_76t5BPO2yuZRlDWLLoH25JceiZ48Q'
  },

  auth: {
    // Анонимный вход: сессия создаётся молча при первом заходе.
    // Прогресс сразу пишется на сервер, никаких кнопок и форм.
    anonymous: true,

    // Именованный вход. Нужен только для переноса прогресса между
    // устройствами и для имён в таблице рекордов.
    // null — кнопки входа не показываются вообще.
    // 'custom:yandex' — после настройки Custom OAuth Provider (см. SETUP.md).
    provider: null,
    providerLabel: 'Яндекс'
  },

  ads: {
    provider: 'stub',        // 'stub' | 'yandex' | 'adsense'
    yandexBlockId: 'R-A-000000-1',
    interstitialCooldown: 90, // сек между полноэкранными
    rewardedSeconds: 15,      // длительность заглушки rewarded
    interstitialSeconds: 5
  }
};
