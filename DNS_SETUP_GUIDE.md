# GitHub Pages Custom Domain Setup Guide

## Problem
Your website at `shreyash-ranjan.com` is not working because the DNS records are not properly configured to point to GitHub Pages.

## ⚠️ Important: DNS Records vs Domain Forwarding

**DO NOT use "Domain Forwarding" or "URL Forwarding"** - these features redirect visitors but don't properly host your site.

What you see as "Forwarding" or "Forward with masking" in your registrar is **NOT** the same as DNS records. You need to:
1. **Remove any domain forwarding rules** for shreyash-ranjan.com
2. **Add DNS A records instead** (instructions below)

### Why Domain Forwarding Doesn't Work
- ❌ Domain forwarding creates a redirect, not a proper DNS connection
- ❌ GitHub Pages won't recognize forwarded traffic correctly
- ❌ SSL certificates won't work properly
- ✅ DNS A records tell the internet where your domain lives
- ✅ GitHub Pages can provision SSL and serve your site properly

## Solution

### Step 1: Configure DNS Records at Your Domain Registrar

**IMPORTANT: Look for "DNS Settings" or "DNS Management", NOT "Forwarding" or "Domain Forwarding"**

You need to add DNS records at your domain registrar (where you purchased `shreyash-ranjan.com`).

#### First: Remove Any Domain Forwarding
If you have set up domain forwarding (like "Forward with masking"), **remove it first**. This is usually found in a separate "Forwarding" section.

#### Second: Find DNS Management
Look for sections named:
- "DNS Settings"
- "DNS Management" 
- "Manage DNS"
- "Advanced DNS"
- "DNS Records"
- "Name Server Records"

**NOT** sections named "Forwarding", "URL Redirect", or "Domain Forwarding". 

**Option A: Using A Records (Recommended for apex domain)**

Add the following **A records** for `shreyash-ranjan.com`:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

**Option B: Using CNAME (For www subdomain)**

If you want to use `www.shreyash-ranjan.com`, add a **CNAME record**:
- Host/Name: `www`
- Points to: `codingshreyash.github.io`

**Best Practice: Use Both**
- Add the 4 A records for the apex domain (`shreyash-ranjan.com`)
- Add a CNAME record for the www subdomain (`www.shreyash-ranjan.com`)

### Step 2: Verify CNAME File in Repository

The `CNAME` file in the root of your repository should contain only:
```
shreyash-ranjan.com
```

This file has been restored in this commit.

### Step 3: Enable HTTPS in GitHub Pages Settings

1. Go to your repository on GitHub
2. Click on "Settings"
3. Scroll down to "Pages" section
4. Under "Custom domain", verify `shreyash-ranjan.com` is listed
5. Check the box for "Enforce HTTPS" (this may take a few minutes after DNS propagates)

### Step 4: Wait for DNS Propagation

DNS changes can take anywhere from a few minutes to 48 hours to fully propagate. You can check the status using:

```bash
dig shreyash-ranjan.com +short
```

You should see the GitHub Pages IP addresses listed above.

## Temporary Access

While DNS is being configured, your site will be accessible at:
- `http://codingshreyash.github.io` (once this PR is merged to main branch)
- `https://codingshreyash.github.io` (if HTTPS is enabled for the GitHub Pages site)

## Verification

Once DNS is configured correctly, you should be able to access your site at:
- `http://shreyash-ranjan.com`
- `https://shreyash-ranjan.com` (recommended)
- `https://www.shreyash-ranjan.com` (if www CNAME is configured)

## Troubleshooting

### I set up "Domain Forwarding" instead of DNS records
If you already configured domain forwarding (like "Forward with masking"):
1. **Remove the forwarding rule** in your registrar's forwarding section
2. Go to the **DNS Management** section (separate from forwarding)
3. Add the A records as specified above
4. Wait for DNS propagation (24-48 hours)

### Site not loading after DNS configuration
- Wait 24-48 hours for full DNS propagation
- Clear your browser cache
- Try accessing from an incognito/private window
- Verify the A records are correctly entered at your registrar

### SSL Certificate Errors
- It can take up to 24 hours for GitHub to provision the SSL certificate
- Make sure "Enforce HTTPS" is checked in GitHub Pages settings

### Where to configure DNS (NOT Forwarding)
Common domain registrars and their DNS management pages:
- **GoDaddy**: Domain Settings → Manage DNS (NOT "Forwarding")
- **Namecheap**: Domain List → Manage → Advanced DNS (NOT "Redirect Domain")
- **Squarespace** (formerly Google Domains): DNS Settings → Custom records
- **Cloudflare**: DNS → Records
- **Porkbun**: DNS → Manage (NOT "URL Forwarding")
- **Hover**: DNS → Edit (NOT "Forward")

**Key Point**: You're looking for a page where you can add A records, CNAME records, TXT records, etc. If you only see options to forward or redirect, you're in the wrong section!

## Reference
For more details, see GitHub's official documentation:
https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site
