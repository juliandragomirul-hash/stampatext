/**
 * Buy Credits Modal — PayPal Smart Buttons integration.
 * Include on any page that needs credit purchases.
 * Requires: auth.js, supabase-client.js, config.js loaded first.
 */
(function () {
  var CREDIT_PACKAGES = [
    { id: 'pack_10',  credits: 10,  price: 29, label: '10 Credits',  priceLabel: '$29' },
    { id: 'pack_50',  credits: 50,  price: 59, label: '50 Credits',  priceLabel: '$59' },
    { id: 'pack_100', credits: 100, price: 99, label: '100 Credits', priceLabel: '$99' }
  ];

  var selectedPackage = CREDIT_PACKAGES[1]; // default: 50 credits
  var paypalButtonsRendered = false;

  // ---- Inject modal HTML into DOM ----
  function injectModalHTML() {
    if (document.getElementById('buy-credits-modal')) return;

    var html =
      '<div class="modal-overlay" id="buy-credits-modal">' +
        '<div class="modal" style="max-width:480px;">' +
          '<button class="modal-close" id="buy-credits-close">&times;</button>' +
          '<h3 class="modal-title">Buy Credits</h3>' +
          '<p style="color:#666;font-size:0.85rem;margin-bottom:1.25rem;">Select a credit package to download stamps.</p>' +
          '<div class="form-error" id="buy-credits-error"></div>' +
          '<div class="download-options" id="buy-credits-packages" style="margin-bottom:1.25rem;"></div>' +
          '<div id="paypal-button-container" style="min-height:45px;"></div>' +
          '<div id="buy-credits-success" style="display:none;text-align:center;padding:1.5rem 0;">' +
            '<div style="font-size:2.5rem;margin-bottom:0.5rem;color:#16a34a;">&#10003;</div>' +
            '<div style="font-size:1.1rem;font-weight:500;color:#16a34a;margin-bottom:0.5rem;">Payment Successful!</div>' +
            '<div id="buy-credits-success-msg" style="color:#666;font-size:0.85rem;"></div>' +
            '<button class="btn btn-primary" id="buy-credits-done" style="margin-top:1rem;">Done</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.insertAdjacentHTML('beforeend', html);
    buildPackageCards();
    bindModalEvents();
  }

  // ---- Build package selection cards ----
  function buildPackageCards() {
    var container = document.getElementById('buy-credits-packages');
    CREDIT_PACKAGES.forEach(function (pkg, i) {
      var card = document.createElement('label');
      card.className = 'download-option-card';
      card.innerHTML =
        '<input type="radio" name="credit-package" value="' + pkg.id + '"' +
        (i === 1 ? ' checked' : '') + '>' +
        '<span class="download-option-label">' + pkg.label + '</span>' +
        '<span class="download-option-size">' + pkg.priceLabel + '</span>';
      container.appendChild(card);
    });

    container.addEventListener('change', function (e) {
      var val = e.target.value;
      selectedPackage = CREDIT_PACKAGES.find(function (p) { return p.id === val; });
    });
  }

  // ---- Bind modal events ----
  function bindModalEvents() {
    document.getElementById('buy-credits-close').addEventListener('click', closeBuyCreditsModal);
    document.getElementById('buy-credits-modal').addEventListener('click', function (e) {
      if (e.target === this) closeBuyCreditsModal();
    });
    document.getElementById('buy-credits-done').addEventListener('click', closeBuyCreditsModal);
  }

  // ---- Show error ----
  function showError(msg) {
    var el = document.getElementById('buy-credits-error');
    el.textContent = msg;
    el.classList.add('visible');
  }

  // ---- Render PayPal Smart Buttons ----
  function renderPayPalButtons() {
    paypalButtonsRendered = true;

    paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 40 },

      createOrder: async function () {
        var session = await getSession();
        if (!session) { showError('Please log in first.'); throw new Error('Not authenticated'); }
        if (!selectedPackage) { showError('Please select a package.'); throw new Error('No package'); }

        var res = await fetch('/api/payments/paypal-create-order', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + session.access_token
          },
          body: JSON.stringify({ package_id: selectedPackage.id })
        });

        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          showError(err.error || 'Failed to create order');
          throw new Error(err.error || 'Create order failed');
        }

        return (await res.json()).order_id;
      },

      onApprove: async function (data) {
        var session = await getSession();
        if (!session) { showError('Session expired. Please log in again.'); return; }

        // Show processing state
        document.getElementById('paypal-button-container').innerHTML =
          '<p style="text-align:center;color:#888;font-size:0.85rem;">Processing payment...</p>';

        var res = await fetch('/api/payments/paypal-capture-order', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + session.access_token
          },
          body: JSON.stringify({ order_id: data.orderID })
        });

        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          showError(err.error || 'Payment capture failed');
          // Re-render PayPal buttons for retry
          document.getElementById('paypal-button-container').innerHTML = '';
          paypalButtonsRendered = false;
          renderPayPalButtons();
          return;
        }

        var result = await res.json();

        // Update header credits
        var creditsEl = document.getElementById('user-credits');
        if (creditsEl) {
          creditsEl.textContent = result.new_balance + ' credits';
          creditsEl.style.display = 'inline-block';
        }

        // Show success state
        document.getElementById('buy-credits-packages').style.display = 'none';
        document.getElementById('paypal-button-container').style.display = 'none';
        document.getElementById('buy-credits-error').classList.remove('visible');
        document.getElementById('buy-credits-success').style.display = '';
        document.getElementById('buy-credits-success-msg').textContent =
          result.credits_added + ' credits added. You now have ' + result.new_balance + ' credits.';
      },

      onCancel: function () { /* modal stays open, user can retry */ },

      onError: function (err) {
        console.error('PayPal error:', err);
        showError('PayPal encountered an error. Please try again.');
      }
    }).render('#paypal-button-container');
  }

  // ---- Open modal ----
  function openBuyCreditsModal() {
    injectModalHTML();

    // Reset to purchase state
    document.getElementById('buy-credits-packages').style.display = '';
    document.getElementById('paypal-button-container').style.display = '';
    document.getElementById('paypal-button-container').innerHTML = '';
    document.getElementById('buy-credits-success').style.display = 'none';
    document.getElementById('buy-credits-error').classList.remove('visible');
    document.getElementById('buy-credits-error').textContent = '';

    document.getElementById('buy-credits-modal').classList.add('active');

    // Render PayPal buttons (handle SDK not loaded yet)
    paypalButtonsRendered = false;
    if (window.paypal) {
      renderPayPalButtons();
    } else {
      document.getElementById('paypal-button-container').innerHTML =
        '<p style="text-align:center;color:#888;font-size:0.85rem;">Loading payment options...</p>';
      var attempts = 0;
      var interval = setInterval(function () {
        attempts++;
        if (window.paypal) {
          clearInterval(interval);
          document.getElementById('paypal-button-container').innerHTML = '';
          renderPayPalButtons();
        } else if (attempts > 20) {
          clearInterval(interval);
          document.getElementById('paypal-button-container').innerHTML =
            '<p style="text-align:center;color:#dc2626;font-size:0.85rem;">Failed to load PayPal. Please refresh the page.</p>';
        }
      }, 500);
    }
  }

  // ---- Close modal ----
  function closeBuyCreditsModal() {
    document.getElementById('buy-credits-modal').classList.remove('active');
  }

  // Expose globally
  window.openBuyCreditsModal = openBuyCreditsModal;
})();
