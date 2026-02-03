# StampaText - Plan Complet Aplicatie

## Stack Tehnologic
- **Frontend**: Vanilla HTML/CSS/JS (fara framework)
- **Hosting**: Vercel (static files + serverless functions)
- **Database**: Supabase PostgreSQL
- **Auth**: Supabase Auth (email/parola)
- **Storage**: Supabase Storage (template-uri + imagini generate)
- **Plati**: Stripe + PayPal
- **Template-uri**: SVG (din Adobe Illustrator) cu text layers predefinite
- **Image generation**: SVG manipulation in browser → export PNG + PDF
- **Repo**: GitHub juliandragomirul-hash/stampatext

## Structura Fisiere

```
e:\stampatext\
  vercel.json
  package.json
  .env.local                   # variabile secrete (nu se comite)
  .gitignore
  server.js                    # doar pt dev local

  api/                         # Vercel serverless functions
    _lib/
      supabase-admin.js        # Supabase service-role client
      stripe.js                # Stripe SDK init
      middleware.js             # Auth verification helper
    payments/
      create-checkout.js       # POST: Stripe checkout session
      webhook-stripe.js        # POST: Stripe webhook
      paypal-create-order.js   # POST: creare comanda PayPal
      paypal-capture-order.js  # POST: capturare plata PayPal
    generations/
      record.js                # POST: deduce credit + salveaza generare
    admin/
      grant-credits.js         # POST: admin acorda credite
      users.js                 # GET: lista utilizatori

  public/
    index.html                 # Galerie template-uri
    login.html                 # Login / Register
    editor.html                # Editor imagini (canvas + text inputs)
    history.html               # Istoric imagini generate
    credits.html               # Cumparare credite
    admin.html                 # Panou admin

    css/
      style.css
      editor.css
      admin.css

    js/
      config.js                # Supabase URL/key, Stripe publishable key
      supabase-client.js       # Init Supabase browser client
      auth.js                  # Login, register, logout, session
      router.js                # Nav guard (redirect daca nu e logat)
      templates.js             # Fetch + afisare galerie
      editor.js                # SVG preview + text input + download
      svg-renderer.js          # Core: load SVG, replace text in layers, export PNG/PDF
      history.js               # Afisare istoric
      credits.js               # Afisare pachete, initiere plata
      admin-templates.js       # CRUD template-uri, upload
      admin-zones.js           # Editor vizual zone text (drag pe canvas)
      admin-users.js           # Lista useri, management credite
```

## Schema Baza de Date

### Tabele

**profiles** - extinde auth.users
- `id` UUID (PK, ref auth.users)
- `email`, `display_name`, `role` ('user'/'admin'), `credits` (integer), `created_at`

**templates** - template-urile SVG
- `id` UUID, `name`, `description`, `svg_path` (path in Storage), `thumbnail_path`, `width`, `height`, `is_active`, `created_at`

**text_zones** - zonele de text din SVG (mapate la text layers din Illustrator)
- `id` UUID, `template_id` (FK), `label` (ex: "Nume", "Data"), `svg_element_id` (id-ul elementului text din SVG), `font_family`, `font_size`, `font_color`, `font_weight`, `text_align`, `max_length`, `sort_order`
- Nota: pozitia vine direct din SVG (nu mai e nevoie de x/y manual) - Illustrator defineste pozitia

**generations** - imaginile generate de utilizatori
- `id` UUID, `user_id` (FK), `template_id` (FK), `storage_path`, `input_data` (JSONB - textul introdus), `created_at`

**credit_transactions** - log tranzactii credite
- `id` UUID, `user_id` (FK), `amount` (+/- integer), `reason` ('purchase'/'generation'/'admin_grant'), `reference_id`, `created_at`

**credit_packages** - pachete de credite de vanzare
- `id` UUID, `name`, `credits`, `price_cents`, `currency`, `stripe_price_id`, `is_active`

### Supabase Storage Buckets
- `templates` - public read, admin write
- `generations` - privat, user-scoped (`generations/{user_id}/`)

### RLS (Row Level Security)
- profiles: user vede doar propriul profil, admin vede tot
- templates: oricine citeste active, admin CRUD
- text_zones: oricine citeste, admin CRUD
- generations: user vede doar ale sale
- credit_transactions: user vede doar ale sale
- credit_packages: oricine citeste active

### Trigger pt creare profil automat
- La `INSERT` pe `auth.users` -> se creaza automat rand in `profiles` cu 0 credite

## Flow-uri Principale

### Generare Imagine
1. User alege template din galerie -> `editor.html?id={template_id}`
2. Browser incarca SVG-ul, afiseaza input-uri pt fiecare text layer
3. Live preview: la fiecare tastare, textul din SVG se actualizeaza instant
4. Click "Generate": frontend apeleaza `POST /api/generations/record`
5. Server verifica credits >= 1, deduce 1 credit (tranzactional), returneaza upload URL
6. Frontend converteste SVG -> PNG (via Canvas) + PDF (via jsPDF/svg2pdf)
7. Uploadeaza in Supabase Storage, afiseaza linkuri descarcare PNG + PDF

### Cum functioneaza SVG-ul
- In Illustrator, fiecare zona de text editabila are un ID unic (ex: `text-name`, `text-date`)
- Admin uploadeaza SVG-ul, aplicatia detecteaza automat elementele `<text>` din SVG
- In admin, se mapeaza fiecare element text la un label vizibil pt user ("Nume", "Data", etc.)
- La editare, browser-ul inlocuieste `textContent` al elementelor `<text>` din SVG DOM
- Avantaj: pozitia, fontul, dimensiunea vin direct din Illustrator - fidelitate 100%

### Plata Credite (Stripe)
1. User alege pachet pe `credits.html`
2. Frontend apeleaza `POST /api/payments/create-checkout`
3. Redirect la Stripe Checkout
4. Stripe trimite webhook -> server acorda credite

### Plata Credite (PayPal)
1. User click buton PayPal
2. `createOrder` -> `POST /api/payments/paypal-create-order`
3. `onApprove` -> `POST /api/payments/paypal-capture-order`
4. Server acorda credite

## Faze de Implementare

### Faza 1: Fundatie
- Setup Supabase: tabele, RLS, storage, trigger
- Structura foldere, `vercel.json` cu rewrites pt API
- `config.js`, `supabase-client.js`, `auth.js`
- `login.html` (register + login)
- `index.html` galerie (cu 1-2 template-uri test)
- Deploy pe Vercel, verificare auth end-to-end

### Faza 2: Panou Admin + Upload Template-uri
- `admin.html` la ruta `/admin`
- Upload SVG -> detectare automata elemente `<text>` din SVG
- Mapare text elements la labels (admin seteaza: "acest text = Nume", "acest text = Data")
- Setare proprietati per zona (max_length, etc.)
- Lista utilizatori, grant credite

### Faza 3: Editor Core
- `svg-renderer.js` - incarcare SVG, inlocuire text, preview live
- `editor.html` cu input-uri pt fiecare zona + preview SVG
- Export PNG (SVG -> Canvas -> PNG) + PDF (jsPDF + svg2pdf.js)
- Descarcare imagine (fara verificare credite, pt test)

### Faza 4: Credite + Stripe
- `credit_packages` in DB
- `credits.html` cu afisare pachete
- `POST /api/payments/create-checkout` (Stripe)
- Stripe webhook handler
- `POST /api/generations/record` (deducere credit)
- Legare editor de sistem credite
- `history.html`

### Faza 5: PayPal + Polish
- PayPal payment
- Responsive design
- Error handling, loading states
- Admin grant credits

### Faza 6: Lansare
- Audit securitate (RLS, roles)
- Chei Stripe/PayPal productie
- Cont admin (set manual `role='admin'` in Supabase)
- Test final pe stampatext.com

## Verificare
- **Faza 1**: Deschide stampatext.com -> login -> vezi galeria -> logout
- **Faza 2**: Alege template -> scrie text -> vezi preview live -> descarcare
- **Faza 3**: Login admin -> upload template -> defineste zone -> apare in galerie
- **Faza 4**: Cumpara credite Stripe -> genereaza imagine -> credit dedus -> apare in istoric
- **Faza 5**: Plata PayPal functioneaza -> site responsive pe mobil
- **Faza 6**: Totul merge pe stampatext.com cu date reale

## Fisiere Critice
- `public/js/svg-renderer.js` - inima aplicatiei (manipulare SVG + export PNG/PDF)
- `api/generations/record.js` - deducere credite (securitate critica)
- `api/payments/webhook-stripe.js` - primire plati (trebuie idempotent)
- `public/js/admin-templates.js` - upload SVG + detectare/mapare text elements
- `vercel.json` - configurare API rewrites + static files

## Conventii SVG din Illustrator
- Fiecare text layer editabil trebuie sa aiba un **id unic** in Illustrator (ex: `text-name`, `text-date`)
- La export SVG din Illustrator: File -> Save As -> SVG, bifat "Responsive"
- Textul din SVG va fi inlocuit programatic prin DOM manipulation

## Conexiuni
- **Supabase URL**: https://yqoyjzljwrltdteeotzw.supabase.co
- **Vercel Environment Variables**: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (configurate)
