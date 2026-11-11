/* Top Speed Service OS — native bridge (Capacitor)
   Loaded only inside the bundled mobile apps. On the regular website this
   file is not referenced; if it ever is, every feature below no-ops safely
   when Capacitor is absent.

   What it provides:
   - window.TSOSNative.isNative — true inside the store apps
   - window.TSOSNative.getLocation() — GPS position (Track My Tech ready)
   - window.TSOSNative.takePhoto() — camera photo as base64 (photo diagnosis)
   - Push notification registration: the device token is stored on-device
     (localStorage tsos_push_token) and broadcast as a 'tsos:push-token'
     document event. The API endpoint that receives tokens is the next
     backend step; nothing is sent anywhere until it exists.
   - Links to other Service OS pages open in the in-app browser instead of
     navigating the app shell away from the bundled app.
*/
(function () {
  var Cap = window.Capacitor;
  var isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  var SITE = 'https://topspeedserviceos.com';

  if (isNative) {
    document.documentElement.classList.add('tsos-native');
  }

  function plugin(name) {
    return (Cap && Cap.Plugins && Cap.Plugins[name]) || null;
  }

  window.TSOSNative = {
    isNative: isNative,

    getLocation: function () {
      var Geo = plugin('Geolocation');
      if (!Geo) return Promise.reject(new Error('Geolocation unavailable'));
      return Geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 }).then(function (pos) {
        return {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp
        };
      });
    },

    watchLocation: function (onPos) {
      var Geo = plugin('Geolocation');
      if (!Geo) return Promise.reject(new Error('Geolocation unavailable'));
      return Geo.watchPosition({ enableHighAccuracy: true }, function (pos, err) {
        if (!err && pos) {
          onPos({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp
          });
        }
      });
    },

    takePhoto: function () {
      var Cam = plugin('Camera');
      if (!Cam) return Promise.reject(new Error('Camera unavailable'));
      return Cam.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: 'base64',
        source: 'PROMPT'
      }).then(function (photo) {
        return photo.base64String || null;
      });
    },

    openPage: function (path) {
      var url = SITE + path;
      var Browser = plugin('Browser');
      if (isNative && Browser) return Browser.open({ url: url });
      window.location.href = url;
      return Promise.resolve();
    }
  };

  if (!isNative) return;

  // --- Push notifications -------------------------------------------------
  (function initPush() {
    var Push = plugin('PushNotifications');
    if (!Push) return;
    Push.addListener('registration', function (token) {
      try { localStorage.setItem('tsos_push_token', token.value); } catch (e) {}
      document.dispatchEvent(new CustomEvent('tsos:push-token', { detail: token.value }));
    });
    Push.addListener('registrationError', function (err) {
      console.warn('Push registration error', err);
    });
    Push.addListener('pushNotificationReceived', function (notification) {
      console.log('Push received', notification && notification.title);
    });
    Push.requestPermissions().then(function (result) {
      if (result && result.receive === 'granted') return Push.register();
    }).catch(function () {});
  })();

  // --- Cross-page links open in the in-app browser ------------------------
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="/"]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href === '/' + location.pathname.split('/').pop()) return;
    e.preventDefault();
    window.TSOSNative.openPage(href);
  });
})();
