# Putting the shop online

**Written 2026-08-22.** This is the whole job, start to finish. It does not need a
developer and it does not put your system on the internet.

---

## What you are actually switching on

A web page customers can open on their phone. It shows what you have today, at
today's rates, and when they order it arrives as a **WhatsApp message from them to
you**. You reply, confirm the weight, pack it. Exactly as you do now on the phone,
except they can see the list first.

**Nothing of your system goes online.** The web page is a few files sitting on a
hosting service. It cannot reach your laptop, your database or your app. All it has
is a list you send it. That is why this can happen now, while the security work is
still unfinished.

The cost of that safety: the list is a snapshot, not live. You send a fresh one each
morning. The page knows this, and after twelve hours it stops claiming anything is in
stock and tells customers to message you instead.

---

## Once, to set it up

**1. Put your shop's phone number in the app.** Settings, then your branch. Without
it the order button has nobody to send the message to. The export will warn you if it
is missing.

**2. Get the site onto the internet.** The simplest way, with no account and no
command line:

- Go to `app.netlify.com/drop`
- Drag the whole `website` folder onto the page
- It gives you an address like `frooz-shop.netlify.app`

That is it. If you later want `frooz.in` or similar, buy the name and point it there
from the same place; the site does not change.

**3. Send the address to a few regular customers first.** Not everyone. Watch what
they do for a week before you put it on the shop sign.

### About a domain name

**You do not need one to start.** The free address the host gives you works, and
customers reach the site from a WhatsApp link anyway - almost nobody types a shop's
address by hand. Buy a name when it is going on the shop sign, a board or a bill,
not before.

When you do: `frooz.in` and `frooz.com` are both already in use by someone else, so
the name is not free. Things like `froozfruits.in` or `frooz.shop` showed nothing,
which suggests they are available but does not prove it - a name can be owned and
sitting unused. Check at a registrar; they will tell you for certain and it takes a
minute.

A `.in` name costs roughly the price of a few kilos of mangoes per year. Buying it is
yours to do - it needs your card and your identity, and the name should be registered
to you and not to anyone helping you set it up. Once you own it, the hosting service
has a "add a domain" step and the site itself does not change.

---

## Every morning, two minutes

**1. Set today's rates** in the app, as you already do.

**2. Open Sale Rate Update.** Under the rates you will find **Today's list for the
website**. It tells you what will be published, for example:

> 14 items ready for the website. 2 left out because today's rate is not set:
> Pomegranate, Guava.

Read that line. If something you are selling is missing, its rate is not set.

**3. Press Save the file.** You get a file named for today, like
`frooz-catalogue-2026-08-22.json`.

**4. Put it on the site.** Drag the `website` folder to Netlify again with the new
file inside it, renamed to `catalogue.json`, in the `data` folder.

If saving the file does not work on your machine, use **Copy the text** instead and
paste it into the file directly on the hosting site.

---

## What the page does with what you send

| What you send | What the customer sees |
| --- | --- |
| An item with today's rate | Its price per kilo, and the day the rate was set |
| An item with no rate set | Nothing. It is left out rather than shown at zero |
| Stock we could read | Nothing special, or "only 4 kg left" when it is low |
| Stock we could not read | "Stock not confirmed", and an offer to message you |
| No stock at all | "Sold out today" |
| A list more than 12 hours old | Prices stay. Every item reads "stock not confirmed" |

That last row is the important one. **A shop that sells online what is not on the
shelf loses that customer for good.** The page would rather say "ask us" than promise
something you cannot deliver.

---

## What happens when someone orders

1. They pick their fruit and press **Send this order on WhatsApp**.
2. WhatsApp opens on their phone with the order already written out: each item, its
   weight, its price, and the total.
3. It arrives as a normal WhatsApp message from them.
4. You reply, confirm the final weight and bill, and put it through the app as you
   would any other order.

Their phone remembers what they ordered, so next time the top of the page offers to
add it all again in one tap. That memory lives on their phone only. It never reaches
you or anyone else.

---

## What it does not do yet, and why

**It does not show live stock.** It shows the list you sent this morning. Live stock
means your system has to be reachable from the internet, and there is real security
work to finish before that is safe. `docs/auth-hardening-plan.md` has the list.

**Orders do not appear in the app by themselves.** They arrive on WhatsApp and you
enter them. Automatic is the same gate as above.

**There is no "track my parcel" page yet.** One is built and ready, but it needs
order data the site cannot have while it is a set of static files. Until then, tell
customers where their parcel is on WhatsApp, which is where they are anyway.

**There are no photographs.** Take them yourself, on your phone, of your actual
crates in your actual shop. Every competitor uses the same bought stock photos and
they all look identical. Yours will not. Until then each item shows its own colour.

---

## If something looks wrong

**An item is missing from the site.** Its sale rate is not set for today. The export
line tells you which ones.

**Everything says "stock not confirmed".** The list is over twelve hours old. Export
a fresh one.

**The order button does nothing.** Your branch has no phone number saved. Add it in
Settings and export again.

**A price is wrong on the site but right in the app.** You have not uploaded since you
changed it.
