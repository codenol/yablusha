import nodemailer from 'nodemailer';

export class SmtpService {
  constructor(config) {
    this.config = config;
    this.transporter = nodemailer.createTransport({
      host: 'smtp.yandex.ru',
      port: 465,
      secure: true,
      auth: {
        user: config.email,
        pass: config.password,
      },
      tls: { rejectUnauthorized: false },
    });
  }

  async send({ from, to, text, attachments = [] }) {
    const mailOptions = {
      from,
      to,
      subject: 'YabluSha',
      text: text || '',
      attachments: attachments.map(att => ({
        filename: att.filename,
        path: att.path,
      })),
    };

    const info = await this.transporter.sendMail(mailOptions);
    return info.messageId;
  }

  async verify() {
    return this.transporter.verify();
  }
}
