export const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const parseGuidList = (value) =>
  String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

export const convictValidateGuidOrEmpty = {
  name: 'guid-or-empty',
  validate: function validateGuidOrEmpty(value) {
    if (value !== '' && !GUID_PATTERN.test(value)) {
      throw new Error('must be a GUID or empty')
    }
  }
}

export const convictValidateGuidList = {
  name: 'guid-list',
  validate: function validateGuidList(value) {
    if (typeof value !== 'string') {
      throw new TypeError('must be a comma-separated string of GUIDs')
    }
    if (!parseGuidList(value).every((item) => GUID_PATTERN.test(item))) {
      throw new Error('must be a comma-separated list of GUIDs')
    }
  }
}
