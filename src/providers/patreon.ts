import type { Provider, Sponsorship } from '../types.ts'
import { $fetch } from 'ofetch'

export const PatreonProvider: Provider = {
  name: 'patreon',
  fetchSponsors(config) {
    if (config.mode === 'sponsees') {
      console.warn('[sponsorkit] Patreon provider does not support `mode: "sponsees"` yet')
      return Promise.resolve([])
    }

    return fetchPatreonSponsors(config.patreon?.token || config.token!)
  },
}

/** API v1 was retired by Patreon on 2026-10-07 and now responds with `410 Gone`. */
const PATREON_API = 'https://www.patreon.com/api/oauth2/v2'
const USER_AGENT = 'SponsorKit (https://github.com/antfu-collective/sponsorkit)'

interface PatreonResource {
  id: string
  type: string
  attributes?: Record<string, any>
  /** JSON:API to-one relationships expose an object, to-many an array. */
  relationships?: Record<string, { data?: { id: string, type: string } | { id: string, type: string }[] | null }>
}

export async function fetchPatreonSponsors(token: string): Promise<Sponsorship[]> {
  if (!token)
    throw new Error('Patreon token is required')

  const campaignId = await fetchPatreonCampaignId(token)

  // API v2 returns up to 1000 members per page and paginates with a `links.next` cursor.
  const sponsors: any[] = []
  let sponsorshipApi: string | undefined = `${PATREON_API}/campaigns/${campaignId}/members?include=user,currently_entitled_tiers&fields%5Bmember%5D=currently_entitled_amount_cents,patron_status,pledge_relationship_start,lifetime_support_cents&fields%5Buser%5D=image_url,url,first_name,full_name&fields%5Btier%5D=amount_cents`

  do {
    const sponsorshipData: any = await patreonFetch(sponsorshipApi, token)
    const included: PatreonResource[] = Array.isArray(sponsorshipData?.included) ? sponsorshipData.included : []
    const members: PatreonResource[] = Array.isArray(sponsorshipData?.data) ? sponsorshipData.data : []

    sponsors.push(
      ...members
        // Filter out "never pledged" members
        .filter(membership => membership.attributes?.patron_status != null)
        .map(membership => ({
          membership,
          patron: included.find(v => v.type === 'user' && v.id === relatedId(membership, 'user', 0)),
          tier: included.find(v => v.type === 'tier' && v.id === relatedId(membership, 'currently_entitled_tiers', 0)),
        })),
    )
    sponsorshipApi = sponsorshipData?.links?.next
  } while (sponsorshipApi)

  return sponsors.map((raw: any): Sponsorship => {
    const attributes = raw.membership.attributes || {}
    // Patreon masks the identity of members who opted out of sharing their profile.
    const patronAttributes = raw.patron?.attributes || {}
    const name = patronAttributes.full_name || patronAttributes.first_name || 'Anonymous'

    const sponsor: Sponsorship = {
      sponsor: {
        avatarUrl: patronAttributes.image_url || '',
        login: patronAttributes.first_name || name,
        name,
        type: 'User', // Patreon only support user
        linkUrl: patronAttributes.url,
      },
      isOneTime: false, // One-time pledges not supported
      monthlyDollars: Math.floor((attributes.currently_entitled_amount_cents || 0) / 100),
      privacyLevel: 'PUBLIC', // Patreon is all public
      tierName: 'Patreon',
      createdAt: attributes.pledge_relationship_start || '',
    }

    // The "former_patron" and "declined_patron" both is past sponsors
    if (['former_patron', 'declined_patron'].includes(attributes.patron_status))
      sponsor.monthlyDollars = -1
    // If the sponsor is not a patron but has a gifted membership, we can still show the tier amount
    else if (sponsor.monthlyDollars <= 0 && (raw.tier?.attributes?.amount_cents || 0) > 0)
      sponsor.monthlyDollars = Math.floor(raw.tier.attributes.amount_cents / 100)

    return sponsor
  })
}

/**
 * Resolve the campaign owned by the authenticated user.
 *
 * Replaces the removed v1 `current_user/campaigns` endpoint (now `410 Gone`).
 */
async function fetchPatreonCampaignId(token: string): Promise<string> {
  const userData: any = await patreonFetch(`${PATREON_API}/campaigns`, token)
  const campaignId = userData?.data?.[0]?.id
  if (!campaignId) {
    throw new Error(
      'No Patreon campaign found for the given token. '
      + 'Make sure the token belongs to a creator account and was created for a v2 client '
      + '(the v2 `campaigns` scope is required).',
    )
  }
  return campaignId
}

/** Read the id at `index` from a JSON:API relationship that may be a to-one or to-many. */
function relatedId(resource: PatreonResource, name: string, index: number): string | undefined {
  const data = resource.relationships?.[name]?.data
  const entry = Array.isArray(data) ? data[index] : data
  return entry?.id
}

async function patreonFetch(url: string, token: string) {
  try {
    return await $fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      responseType: 'json',
    })
  }
  catch (error: any) {
    // `$fetch` wraps non-2xx responses; surface a hint for the v1 retirement.
    if (error?.response?.status === 410) {
      throw new Error(
        `Patreon API returned 410 Gone for ${url}. `
        + 'The v1 API was retired on 2026-10-07; register a new v2 client and use its "Creator\'s Access Token".',
        { cause: error },
      )
    }
    throw error
  }
}
