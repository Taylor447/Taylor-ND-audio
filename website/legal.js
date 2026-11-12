// Chuyển ngôn ngữ trên trang pháp lý mà không lưu cookie hay gửi dữ liệu.
(() => {
  const button = document.getElementById("languageToggle");
  if (!button) return;
  let language = "vi";
  button.addEventListener("click", () => {
    language = language === "vi" ? "en" : "vi";
    document.documentElement.lang = language;
    document.querySelectorAll("[data-language]").forEach((section) => {
      section.hidden = section.dataset.language !== language;
    });
    button.textContent = language === "vi" ? "EN" : "VI";
    button.setAttribute("aria-label", language === "vi" ? "EN — Switch language to English" : "VI — Chuyển ngôn ngữ sang tiếng Việt");
  });
})();
