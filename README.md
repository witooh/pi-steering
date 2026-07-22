# pi-steering

Pi extension สำหรับอ่าน
[Kiro Steering](https://kiro.dev/docs/steering/)
จากโปรเจกต์เดิม โดยไม่ต้องย้ายไฟล์หรือเขียนกฎซ้ำ

## รองรับ

<!-- markdownlint-disable MD013 -->

| Kiro Steering | พฤติกรรมใน Pi |
| --- | --- |
| Global scope | อ่าน `~/.kiro/steering/**/*.md` |
| Workspace scope | อ่าน `<cwd>/.kiro/steering/**/*.md` เมื่อ project trusted |
| `inclusion: always` | เพิ่มเนื้อหาใน system prompt ทุก request และเป็นค่า default เมื่อไม่มี frontmatter |
| `inclusion: fileMatch` | จับคู่ glob กับ path relative จาก workspace และส่ง steering ก่อนทำงานกับไฟล์ |
| `inclusion: manual` | เรียกด้วย `#ชื่อไฟล์` หรือ `/steering <ชื่อไฟล์>` |
| `inclusion: auto` | แสดง `name`, `description` และ path ให้ agent โหลดเมื่อ request ตรงคำอธิบาย |
| `#[[file:path]]` | อ่านไฟล์ relative จาก workspace เข้าบริบทโดยป้องกัน path traversal |

<!-- markdownlint-enable MD013 -->

เมื่อกฎ global และ workspace ขัดกัน extension จะวาง workspace steering
ไว้ทีหลังและระบุให้ workspace มี priority ตาม Kiro

## ติดตั้ง

จาก GitHub:

```bash
pi install git:github.com/witooh/pi-steering
```

ทดลองจาก checkout นี้โดยไม่ติดตั้ง:

```bash
npm install
pi -e .
```

Pi โหลด package ผ่าน `pi.extensions` ใน `package.json`

## ตัวอย่าง

### Always included

`.kiro/steering/project.md`

```markdown
# Project conventions

- Use pnpm.
- Add tests for behavior changes.
```

หรือระบุชัดเจน:

```markdown
---
inclusion: always
---

# Project conventions
```

### Conditional inclusion

```markdown
---
inclusion: fileMatch
fileMatchPattern: ["**/*.ts", "**/*.tsx"]
---

# TypeScript conventions
```

เมื่อ file tool ของ Pi เปิดหรือแก้ path ที่ตรง pattern
extension จะเพิ่มกฎนี้เข้าบริบท ถ้าเป็น `edit` หรือ `write` ครั้งแรก
extension จะ block การแก้หนึ่งรอบและให้ agent retry หลังได้รับกฎแล้ว

### Manual inclusion

```markdown
---
inclusion: manual
---

# Review checklist
```

เรียกใช้ได้สองแบบ:

```text
ตรวจโค้ดนี้ตาม #review
/steering review ตรวจ staged changes
```

ชื่อ manual steering มาจากชื่อไฟล์ (`review.md` → `review`)

### Auto inclusion

```markdown
---
inclusion: auto
name: api-design
description: REST API conventions. Use when creating or changing API endpoints.
---

# API design rules
```

Extension ใส่เฉพาะ metadata นี้ใน system prompt
เพื่อให้ agent ตัดสินใจโหลดเนื้อหาเมื่อเกี่ยวข้อง
และยังเรียกตรงได้ด้วย `#api-design` หรือ `/steering api-design`

### Live file reference

```markdown
Follow the contract in #[[file:docs/api.md]].
```

Path ต้องอยู่ภายใน workspace และเนื้อหาแต่ละ reference จำกัดไว้ที่ 50 KiB
เพื่อไม่ให้ context โตเกินจำเป็น

## ข้อจำกัด

- `fileMatch` trigger อัตโนมัติได้กับ tool call ที่เปิดเผย argument ชื่อ
  `path`; shell/custom tools ที่ซ่อน path ไว้ใน command จะอาศัย steering
  index ที่บอก agent ให้โหลดกฎก่อนทำงาน
- `auto` ใช้การตัดสินใจของ model จาก `description` เช่นเดียวกับแนวคิดของ
  Kiro จึงควรเขียน description ให้เฉพาะเจาะจง
- Workspace root คือ current working directory ที่ใช้เปิด Pi
- ไฟล์ steering ที่ frontmatter ไม่ถูกต้องจะถูกข้ามพร้อม warning
  แทนการโหลดแบบผิดเงื่อนไข

## พัฒนา

```bash
npm test
npm run typecheck
```

## แหล่งอ้างอิง

- Kiro Steering: <https://kiro.dev/docs/steering/>
- Pi Extensions:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi Packages:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
